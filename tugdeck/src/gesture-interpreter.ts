/**
 * gesture-interpreter.ts — the deck's one owner of the raw pointer stream.
 *
 * Every document-level pointer listener that used to live in
 * `pane-focus-controller.ts` and `responder-chain-provider.tsx` is installed
 * here, and every pointer gesture is classified exactly once into a
 * `GestureClassification` record. Consumers read the record; none re-derive it
 * from the event.
 *
 * **Why one classifier.** The activation path, the chain-promotion path, the
 * engine-placement path and the browser-default-suppression path each used to
 * walk the event target themselves. Four independent walks that had to agree
 * by hand: a `draggable` mirror predicate on both sides of the deferred-drag
 * latch, a cross-module one-shot latch to hand placement suppression from the
 * activation classifier to the placement classifier, a scrim check written
 * twice. Consumers reading one record cannot disagree, and registration order
 * stops being a correctness input.
 *
 * **Ordering.** The interpreter's listeners must fire before every consumer's,
 * because consumers read `currentGesture()` inside their own capture-phase
 * listeners. `installGestureInterpreter` is called from
 * `usePaneFocusController`'s `useLayoutEffect`, which runs in `deck-canvas.tsx`
 * — a child of `ResponderChainProvider`. Child layout effects run before the
 * parent's, so these listeners register (and therefore fire) first. The install
 * site must stay in the controller or another descendant of the provider.
 *
 * **Stream healing.** WebKit delivers no `pointerdown` for the first click
 * after a native drag session. The resync pair registers ahead of everything
 * else and synthesizes the missing `pointerdown` synchronously from the
 * mousedown, so classification has completed by the time the remaining
 * mousedown listeners read the record.
 *
 * Tuglaws:
 *   - **L03** — listeners register in `useLayoutEffect`, before paint.
 *   - **L06** — the record is transient module state, never React state.
 *   - **L22** — classification reads the deck store and the focus engine
 *     directly; no round trip through React.
 *
 * @module gesture-interpreter
 */

import { getFocusManager } from "@/components/tugways/focus-manager";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { DRAG_MOVE_THRESHOLD_PX } from "@/lib/press-travel";

/**
 * Target-identity marker for the deck canvas's background surface. A
 * pointerdown whose target *is* a marked element is a deliberate deselect; a
 * pointerdown that merely misses every pane (a portal gap, an overlay seam,
 * below-the-fold geometry) is not.
 */
export const CANVAS_BACKGROUND_ATTRIBUTE = "data-deck-canvas-background";

/**
 * Declarative placement policy. The nearest ancestor carrying this attribute
 * decides whether the gesture may move the engine's key view: `"suppress"`
 * stands the placement down, `"place"` re-enables it for a subtree inside a
 * suppressing region.
 */
export const PLACEMENT_POLICY_ATTRIBUTE = "data-tug-placement";

const FOCUS_REFUSE_SELECTOR = '[data-tug-focus="refuse"]';
const FR_PRESERVE_SELECTOR = "[data-tug-fr-preserve]";
const CANVAS_OVERLAY_SELECTOR = '[data-slot="tug-canvas-overlay-root"]';
const CARD_MODAL_SCRIM_SELECTOR = '[data-inline-dialog-pending="true"]';
const DIALOG_ISLAND_SELECTOR =
  ".session-question-dialog, .session-permission-dialog";

/** Where the gesture landed, resolved once. */
export type GestureSite =
  | "pane"
  | "canvas-background"
  | "overlay"
  | "chrome"
  | "outside-deck";

export interface GestureClassification {
  /** Monotonic gesture id, for consumers that must pair pointerdown with a later phase. */
  gestureId: number;
  button: number;
  site: GestureSite;
  paneId: string | null;
  /** Closest `[data-card-id]` to the gesture target. */
  cardId: string | null;
  /** The activation decision. */
  activation: "activate" | "deferred" | "none" | "deselect";
  /**
   * The transfer an `activate` / `deferred` gesture carries. Present even when
   * the incoming card is already the first responder — that gesture still runs
   * the transfer (it is how a click back onto the only pane leaves a deselected
   * deck), it just carries none of the cross-card consequences below.
   */
  activationTransfer: {
    outgoingCardId: string | null;
    incomingCardId: string;
  } | null;
  /** Chain-promotion decision. */
  promotion: { kind: "target" } | { kind: "redirect"; to: Element } | { kind: "skip" };
  /** Engine pointer-placement decision. */
  placement: "place" | "suppressed" | "skip";
  /** Whether the paired mousedown's browser focus default is prevented. */
  preventMousedownDefault: boolean;
  /**
   * The modifiers held when the gesture began.
   *
   * Recorded here so a surface that means something by them — a list building a
   * multi-selection, where ⌘ toggles and ⇧ extends — reads the same record as
   * everything else rather than re-deriving from an event it may see at a
   * different phase. The interpreter already reads `metaKey` for its own
   * activation decision (⌘-click interacts with a background pane without
   * raising it); publishing the pair costs nothing and keeps one source.
   */
  metaKey: boolean;
  shiftKey: boolean;
  /** Named reasons, for the dev log and tests. */
  reasons: string[];
}

/** What the interpreter needs from its host, and what it hands back. */
export interface GestureInterpreterHost {
  deckRoot: () => HTMLElement | null;
  store: IDeckManagerStore;
  /** Run the activation transfer. Called synchronously for `activate`, at pointerup for `deferred`. */
  activate: (transfer: {
    outgoingCardId: string | null;
    incomingCardId: string;
  }) => void;
  /**
   * Bring the card a CLICK activated fully into view. Called at the release
   * of a press that activated and then travelled under the click threshold;
   * never for a press that became a drag, whose drop answers for itself.
   * The press itself activates without moving anything (the hand is on the
   * card), so this is the reveal's other half, at the moment the hand lets go.
   */
  reveal: (cardId: string) => void;
  /** Clear the active card. Called synchronously for `deselect`. */
  deselect: () => void;
}

let current: GestureClassification | null = null;
let nextGestureId = 1;

/** The installed host, for entry points that arrive outside the pointer stream. */
let installedHost: GestureInterpreterHost | null = null;

/** The live gesture's classification, or `null` between gestures. */
export function currentGesture(): GestureClassification | null {
  return current;
}

function elementFor(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

/**
 * Controls marked `data-tug-focus="refuse"` sit outside the key loop: no
 * pointer gesture on them moves any keyboard register (Cocoa's
 * `acceptsFirstResponder = false`).
 */
function isFocusRefusing(el: Element | null): boolean {
  return el !== null && el.closest(FOCUS_REFUSE_SELECTOR) !== null;
}

/**
 * The refusal predicate for events that are not pointer gestures — a `focusin`
 * arriving through a control's own channel asks the same question the gesture
 * classification does, so it asks it here rather than keeping a second copy.
 */
export function targetRefusesFocus(target: EventTarget | null): boolean {
  return isFocusRefusing(elementFor(target));
}

/**
 * Structural gesture surfaces (the pane title bar) are activation and drag
 * targets, never responder targets — promoting the coarse container would
 * strand every accelerator registered on the card's content, since the chain
 * walk is upward-only.
 */
function isFrPreserving(el: Element | null): boolean {
  return el !== null && el.closest(FR_PRESERVE_SELECTOR) !== null;
}

/**
 * A stray click on a modal scrim promotes the dialog island instead of the
 * click target, so the gesture activates the card while first responder stays
 * on the dialog. Returns the island to redirect to, or `null` on the common
 * path.
 */
function modalScrimRedirectTarget(el: Element | null): Element | null {
  if (el === null) return null;
  // Pane-modal barrier: the pane's built-in scrim only receives pointer events
  // while a sheet has raised it, so a pointerdown on the scrim is a stray click
  // on a pane-modal surround. Redirect to the topmost open sheet in that pane.
  if (el.classList.contains("tug-pane-scrim")) {
    const pane = el.closest(".tug-pane");
    if (pane !== null) {
      const sheets = pane.querySelectorAll('[data-slot="tug-sheet"]');
      if (sheets.length > 0) return sheets[sheets.length - 1];
    }
    return null;
  }
  let card = el.closest(CARD_MODAL_SCRIM_SELECTOR);
  if (card === null) {
    // Pane chrome around a card-modal card — the title bar, frame and resize
    // edges live outside the card root that carries the scrim attribute, but
    // the modality covers them all the same. Match the pane whose VISIBLE card
    // is card-modal (an inactive tab's dialog is display:none → no offsetParent).
    const pane = el.closest(".tug-pane");
    const paneModal =
      pane?.querySelector<HTMLElement>(CARD_MODAL_SCRIM_SELECTOR) ?? null;
    card = paneModal !== null && paneModal.offsetParent !== null ? paneModal : null;
  }
  if (card === null) return null;
  // A click already inside the bright dialog island behaves normally.
  if (el.closest(DIALOG_ISLAND_SELECTOR) !== null) return null;
  return card.querySelector(DIALOG_ISLAND_SELECTOR);
}

/**
 * A gesture on draggable content in a card that is not the key card. Promotion
 * stands down for it: the pane activation is deferred until the gesture reveals
 * itself as a click or a drag, and promoting eagerly would strand the chain
 * first responder on the drag source while the deck first responder stayed on
 * the key card.
 */
function isDraggableBackground(el: Element | null, cardId: string | null): boolean {
  if (el === null || cardId === null) return false;
  if (el.closest('[draggable="true"]') === null) return false;
  return cardId !== getFocusManager()?.keyCard();
}

function placementIsSuppressedByPolicy(el: Element | null): boolean {
  if (el === null) return false;
  const marked = el.closest<HTMLElement>(`[${PLACEMENT_POLICY_ATTRIBUTE}]`);
  return marked?.getAttribute(PLACEMENT_POLICY_ATTRIBUTE) === "suppress";
}

/**
 * Whether the gesture landed inside a text-entry surface — a contenteditable
 * (the CM6 substrates), an `<input>`, a `<textarea>`, or anywhere in a
 * `.tug-text-editor` **host**.
 *
 * The one class of target whose browser mousedown default is not just harmless
 * but *required*: it is what puts the caret at the character the user clicked.
 * Everywhere else the default either clears focus to `<body>` or fights the
 * engine's own placement, which is why it is suppressed on an activating click.
 *
 * The host, not just `contentDOM`: an editor is taller than its text (the
 * composer opens at a min-height), and the blank band below the last line is
 * `cursor: text` and lands the caret through `host-click.ts` — it is editor as
 * far as the user is concerned. Testing only `isContentEditable` made the
 * activating click drill down when it hit a line of text and not when it hit the
 * empty space under it, which on an empty composer is nearly all of it.
 */
function isTextEntryTarget(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.closest("input, textarea, .tug-text-editor") !== null;
}


/**
 * What classification reads off a gesture. A real `MouseEvent` /
 * `PointerEvent` satisfies it structurally; the host's activation click
 * (which has a point but no event) synthesizes one.
 */
interface GestureInput {
  target: EventTarget | null;
  button: number;
  metaKey: boolean;
  shiftKey?: boolean;
}

function classify(
  event: GestureInput,
  host: GestureInterpreterHost,
  extraReasons: string[],
): GestureClassification {
  const reasons = [...extraReasons];
  const startEl = elementFor(event.target);
  const root = host.deckRoot();
  const cardEl = startEl?.closest<HTMLElement>("[data-card-id]") ?? null;
  const cardId = cardEl?.getAttribute("data-card-id") ?? null;

  // ---- Site ----
  const panes = host.store.getSnapshot().panes;
  let pane: (typeof panes)[number] | undefined;
  let site: GestureSite;
  if (startEl === null || root === null || !root.contains(startEl)) {
    // Portaled overlays (menus, sheets, tooltips, the fallback context menu)
    // render outside the deck root and never drive pane activation.
    site = "outside-deck";
  } else if (startEl.closest(CANVAS_OVERLAY_SELECTOR) !== null) {
    // The overlay tier hosts popups and completion menus that sit outside every
    // pane in the DOM. Without this, a click on a completion item would read as
    // a canvas-background gesture.
    site = "overlay";
  } else {
    const paneEl = startEl.closest("[data-pane-id]");
    if (paneEl !== null) {
      // Climb to the first ancestor that resolves to a real pane in the store.
      // Internal tab bars (Settings, the gallery, the help sheet) stamp a
      // synthetic `data-pane-id` on their own bar div.
      let candidateEl: Element | null = paneEl;
      while (candidateEl) {
        const candidateId = candidateEl.getAttribute("data-pane-id");
        pane = candidateId ? panes.find((p) => p.id === candidateId) : undefined;
        if (pane) break;
        candidateEl = candidateEl.parentElement?.closest("[data-pane-id]") ?? null;
      }
      if (pane) {
        site = "pane";
      } else {
        site = "chrome";
        reasons.push("unresolved-pane");
      }
    } else if (startEl.hasAttribute(CANVAS_BACKGROUND_ATTRIBUTE)) {
      site = "canvas-background";
    } else {
      // Inside the deck, outside every pane, and not the background surface
      // itself: a portal gap, an overlay seam, or below-the-fold geometry.
      // Deselect is a deliberate gesture, not the absence of a pane.
      site = "chrome";
      reasons.push("canvas-gap");
    }
  }

  // ---- Activation ----
  let activation: GestureClassification["activation"] = "none";
  let activationTransfer: GestureClassification["activationTransfer"] = null;
  if (event.button !== 0) {
    // Primary button only: a right-click shows a context menu without moving
    // focus or collapsing the selection it is about to act on.
    reasons.push("non-primary-button");
  } else if (site === "canvas-background") {
    activation = "deselect";
  } else if (site !== "pane" || pane === undefined) {
    reasons.push(site);
  } else if (event.metaKey) {
    // Mac convention: interact with a background window without raising it.
    reasons.push("meta");
  } else if (startEl !== null && startEl.closest("[data-no-activate]") !== null) {
    reasons.push("no-activate");
  } else if (
    startEl !== null &&
    startEl.classList.contains("tug-pane-scrim") &&
    host.store.getFirstResponderCardId() === pane.activeCardId
  ) {
    // A stray click on an already-active pane's raised scrim: re-running the
    // transfer would coarsen the key view out of the open sheet.
    reasons.push("pane-modal-scrim");
  } else {
    const outgoingCardId = host.store.getFirstResponderCardId();
    const incomingCardId = pane.activeCardId;
    activationTransfer = { outgoingCardId, incomingCardId };
    if (
      outgoingCardId !== incomingCardId &&
      startEl !== null &&
      startEl.closest('[draggable="true"]') !== null
    ) {
      // A click and a drag want opposite outcomes here: the click activates,
      // the drag leaves the source card inactive and needs the paired mousedown
      // left alone (a prevented mousedown never begins a native drag). Park the
      // decision; the gesture's ending resolves it.
      activation = "deferred";
      reasons.push("deferred-drag");
    } else {
      activation = "activate";
      if (outgoingCardId === incomingCardId) reasons.push("already-first-responder");
    }
  }
  const crossCard =
    activationTransfer !== null &&
    activationTransfer.outgoingCardId !== activationTransfer.incomingCardId;

  // ---- Chain promotion ----
  const refusing = isFocusRefusing(startEl);
  const frPreserving = isFrPreserving(startEl);
  const scrimRedirect = refusing || frPreserving
    ? null
    : modalScrimRedirectTarget(startEl);
  let promotion: GestureClassification["promotion"];
  if (refusing) {
    promotion = { kind: "skip" };
    reasons.push("refuse");
  } else if (frPreserving) {
    promotion = { kind: "skip" };
    reasons.push("fr-preserve");
  } else if (scrimRedirect !== null) {
    promotion = { kind: "redirect", to: scrimRedirect };
    reasons.push("modal-scrim");
  } else if (isDraggableBackground(startEl, cardId)) {
    promotion = { kind: "skip" };
    reasons.push("draggable-background");
  } else {
    promotion = { kind: "target" };
  }

  // ---- Engine placement ----
  let placement: GestureClassification["placement"];
  if (promotion.kind !== "target") {
    placement = "skip";
  } else if (placementIsSuppressedByPolicy(startEl)) {
    placement = "suppressed";
    reasons.push("placement-policy");
  } else if (activation === "activate" && crossCard) {
    // First-click-activates, and the click drills through to what it landed on.
    // The transfer runs first (synchronously, in `onPointerDown`, before any
    // consumer reads this record), restoring the card's recorded destination;
    // the place that follows then moves the keyboard to the target the user
    // actually aimed at. So one click activates AND lands the caret, instead of
    // activating and asking for a second click on the same pixel.
    //
    // Only into a TEXT surface. That is the target whose aim is unambiguous —
    // a caret goes exactly where the click landed — and it is the one the
    // browser's own mousedown default already knows how to serve. Everything
    // else on a background card keeps the old behavior deliberately: a click on
    // transcript prose is a click on *the card*, and the destination it wants
    // is the card's recorded one, not a ring parked on the list under the
    // pointer (at0201). Widening this to every engine-addressable target is
    // exactly the change that broke that.
    if (isTextEntryTarget(startEl)) {
      placement = "place";
      reasons.push("activation-drill-down");
    } else {
      placement = "suppressed";
      reasons.push("activation-click");
    }
  } else if (cardId === null) {
    placement = "skip";
    reasons.push("no-card");
  } else if (cardId !== getFocusManager()?.keyCard()) {
    placement = "skip";
    reasons.push("not-key-card");
  } else {
    placement = "place";
  }

  // ---- Browser mousedown default ----
  // WebKit's mousedown default walks up for a focusable element and, finding
  // none, clears focus to body — which strips the caret an activation transfer
  // just placed, and blurs the editor beside a chrome control.
  let preventMousedownDefault =
    refusing || frPreserving || scrimRedirect !== null;
  if (
    !preventMousedownDefault &&
    startEl !== null &&
    root !== null &&
    root.contains(startEl) &&
    startEl.closest("[data-pane-id]") !== null &&
    !event.metaKey &&
    startEl.closest("[data-no-activate]") === null
  ) {
    if (activation === "deferred") {
      // Nothing placed to protect, and preventing the default would stop the
      // browser from ever beginning the native drag this may turn out to be.
      preventMousedownDefault = false;
    } else if (crossCard && event.button === 0 && !isTextEntryTarget(startEl)) {
      // Cross-card activation suppresses the default — EXCEPT into a text
      // surface, which is the one target the default serves: CM6 reads
      // `defaultPrevented` and declines to move its selection, so preventing
      // here is what made an activating click land the card but not the caret.
      // Letting it through is the second half of the drill-down above; the
      // engine's place has already granted the surface focus, and the default
      // only decides WHERE in it the caret sits.
      preventMousedownDefault = true;
    } else if (startEl.closest("[data-card-host]") !== null) {
      // Card content: the browser's default is the correct outcome (click an
      // input, focus the input).
      preventMousedownDefault = false;
    } else if (startEl.closest('[data-slot="tug-sheet"]') !== null) {
      // A sheet is portaled into the pane frame, a sibling of the card host, so
      // the exemption above misses it — but its inputs are genuine content.
      preventMousedownDefault = false;
    } else {
      // Pane chrome with no focusable under the click.
      preventMousedownDefault = true;
    }
  }

  return {
    gestureId: nextGestureId++,
    button: event.button,
    site,
    paneId: pane?.id ?? null,
    cardId,
    activation,
    activationTransfer,
    promotion,
    placement,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey === true,
    preventMousedownDefault,
    reasons,
  };
}

export function installGestureInterpreter(
  host: GestureInterpreterHost,
): () => void {
  // The parked half of a deferred activation, resolved by whichever ending
  // arrives: `dragstart` cancels, `pointerup` commits. The two are mutually
  // exclusive — once a native drag begins the browser ends the gesture with
  // `dragend`, never `pointerup`.
  let pendingActivation: {
    outgoingCardId: string | null;
    incomingCardId: string;
  } | null = null;

  /**
   * The press that activated, until it ends. A release that travelled less
   * than the click threshold is a click, and a click's ending is when the
   * deck may reveal the card the press activated (`host.reveal`); a release
   * that travelled is a drag, and the drop answers for itself. The threshold
   * is `DRAG_MOVE_THRESHOLD_PX` — the pane drag's own, and now the one copy
   * both read (`lib/press-travel.ts`), so the two gestures cannot come to
   * different answers about where a click stops being one ([B04]).
   */
  let press: {
    cardId: string;
    x: number;
    y: number;
    travelled: boolean;
  } | null = null;

  function clearPendingActivation(): void {
    if (pendingActivation === null) return;
    pendingActivation = null;
    getFocusManager()?.endDeferredGesture();
  }

  function commitPendingActivation(): void {
    const pending = pendingActivation;
    pendingActivation = null;
    if (pending === null) return;
    host.activate(pending);
    // A deferred activation commits only at a release no drag claimed — a
    // click — so it reveals as a click does.
    host.reveal(pending.incomingCardId);
    // Closed AFTER the transfer: the transfer's own focus writes are the legal
    // outcome, and the browser-default churn window ends with them.
    getFocusManager()?.endDeferredGesture();
  }

  function onPointerDown(event: PointerEvent): void {
    clearPendingActivation();
    press = null;
    current = classify(event, host, []);
    if (current.activation === "deselect") {
      host.deselect();
      return;
    }
    if (current.activation === "deferred" && current.activationTransfer !== null) {
      pendingActivation = current.activationTransfer;
      // The gesture keeps the browser's mousedown focus default, so tell the
      // engine to read the resulting focus move as browser churn rather than a
      // raw write worth ledgering.
      getFocusManager()?.beginDeferredGesture();
      return;
    }
    if (current.activation === "activate" && current.activationTransfer !== null) {
      host.activate(current.activationTransfer);
      press = {
        cardId: current.activationTransfer.incomingCardId,
        x: event.clientX,
        y: event.clientY,
        travelled: false,
      };
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (press === null || press.travelled) return;
    if (
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >=
      DRAG_MOVE_THRESHOLD_PX
    ) {
      press.travelled = true;
    }
  }

  function onMouseDown(event: MouseEvent): void {
    // A mousedown with no gesture behind it (an untrusted synthetic press the
    // resync shim deliberately does not heal) still needs a record — consumers
    // read the same facts on either event.
    if (current === null) current = classify(event, host, ["mousedown-only"]);
    if (current.preventMousedownDefault) event.preventDefault();
  }

  // Pointer-stream resync for the first click after a native drag. WebKit
  // delivers no `pointerdown` there: the drag consumed the stream's release, so
  // the state machine still holds the pointer down and the next press emits only
  // `mousedown`. `dispatchEvent` is synchronous, so the whole pointerdown pass
  // completes before the remaining mousedown listeners run.
  let sawTrustedPointerDown = false;
  function trackPointerDown(event: PointerEvent): void {
    if (event.isTrusted) sawTrustedPointerDown = true;
  }
  function resyncPointerStreamOnMouseDown(event: MouseEvent): void {
    const saw = sawTrustedPointerDown;
    sawTrustedPointerDown = false;
    if (saw || !event.isTrusted || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: event.button,
        buttons: event.buttons,
        detail: event.detail,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }),
    );
  }

  function onDragStart(): void {
    clearPendingActivation();
    press = null;
    current = null;
  }
  function onPointerUp(): void {
    const ended = press;
    press = null;
    commitPendingActivation();
    if (ended !== null && !ended.travelled) host.reveal(ended.cardId);
    current = null;
  }
  function onGestureAbandoned(): void {
    clearPendingActivation();
    press = null;
    current = null;
  }

  installedHost = host;

  // The resync pair registers FIRST so a healed pointerdown is classified
  // before `onMouseDown` reads the record.
  document.addEventListener("pointerdown", trackPointerDown, { capture: true });
  document.addEventListener("mousedown", resyncPointerStreamOnMouseDown, {
    capture: true,
  });
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("mousedown", onMouseDown, { capture: true });
  document.addEventListener("dragstart", onDragStart, { capture: true });
  document.addEventListener("pointermove", onPointerMove, { capture: true });
  document.addEventListener("pointerup", onPointerUp, { capture: true });
  document.addEventListener("pointercancel", onGestureAbandoned, { capture: true });
  document.addEventListener("dragend", onGestureAbandoned, { capture: true });

  return () => {
    document.removeEventListener("pointerdown", trackPointerDown, { capture: true });
    document.removeEventListener("mousedown", resyncPointerStreamOnMouseDown, {
      capture: true,
    });
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("mousedown", onMouseDown, { capture: true });
    document.removeEventListener("dragstart", onDragStart, { capture: true });
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    document.removeEventListener("pointerup", onPointerUp, { capture: true });
    document.removeEventListener("pointercancel", onGestureAbandoned, {
      capture: true,
    });
    document.removeEventListener("dragend", onGestureAbandoned, { capture: true });
    current = null;
    pendingActivation = null;
    press = null;
    installedHost = null;
  };
}

/**
 * Activate whatever sits under a viewport point, for the macOS host's
 * click-through activation: the click that brings a backgrounded Tug.app
 * forward is consumed by AppKit and never reaches the document, so the host
 * hands the point here and the deck activates the pane/card the user aimed at.
 *
 * The point runs through the same `classify` the pointer stream uses, so every
 * activation rule holds — a `[data-no-activate]` control, a pane-modal scrim, a
 * point outside every pane. Only the activation half is realized: an activation
 * click places no caret and presses nothing, and a point on the canvas
 * background leaves the current selection alone rather than deselecting.
 *
 * Returns the activated card id, or `null` when the point activates nothing.
 */
export function activateAtViewportPoint(
  clientX: number,
  clientY: number,
): string | null {
  const host = installedHost;
  if (host === null) return null;
  const target = document.elementFromPoint(clientX, clientY);
  if (target === null) return null;
  const classification = classify(
    { target, button: 0, metaKey: false },
    host,
    ["host-activation-click"],
  );
  const transfer = classification.activationTransfer;
  if (transfer === null) return null;
  host.activate(transfer);
  return transfer.incomingCardId;
}
