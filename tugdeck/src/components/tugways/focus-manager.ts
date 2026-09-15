/**
 * FocusManager -- tugways focus engine, per-card (the key-window model).
 *
 * Focus state is owned **per card**, not pooled deck-global. Each card is a
 * self-contained focus universe: its own focus-mode stack (cycle / card-modal
 * trap / descend), its own key view (the element keystrokes land on), its own
 * key-within, its own default-ring stack, and its own app-authored focusable
 * registry. That universe lives in a {@link FocusContext}.
 *
 * `FocusManager` is the deck **coordinator** (the AppKit *app object* to the
 * context's *key window*): it owns only deck-global settings (ring modality,
 * keyboard-access mode), the responder-chain attachment, the subscriber set +
 * version, and the **key-card** pointer plus the `cardId → FocusContext` map. Its
 * public API delegates every walk / seed / projection / engine call to the **key
 * card's** context (the active context). Switching the key card is an O(1) context
 * swap; an inactive card's context is untouched, so a mid-flow cycle, a pending
 * card-modal dialog, or a descended scope is preserved **by construction** — no
 * tagging a shared stack, no suspend/restore reconciliation.
 *
 * Data-flow direction (the inversion that keeps key-card single-sourced): the key
 * card is **activation-driven**, not focus-derived. The activation-focus channel
 * (`applyBagFocus` in `focus-transfer.ts`) calls {@link FocusManager.setKeyCard}
 * (or {@link FocusManager.adoptKeyCard}); that sets `keyCardId`, projects THAT
 * context's marks, and only then does the responder chain's `getKeyCard()` DOM
 * fallback find the just-projected key view. Projection is downstream of the key
 * card, never an independent source — so the two can never diverge.
 *
 * Default context ([L26] + the no-card invariant): when no key card is set (a
 * `new FocusManager()` in the pure-logic tests, the gallery, a standalone
 * preview), the coordinator services a single **default context**. Registering
 * with no `cardId` routes there and the walk/seed/projection all operate on it,
 * so the per-card refactor is purely additive — the focus-walk suite passes
 * unchanged against the default context, and every hook stays a clean no-op with
 * no manager.
 *
 * Co-locates `FocusManagerContext` so the provider and `useFocusable` can import
 * it without a circular dependency -- the same pattern `responder-chain.ts` uses
 * for `ResponderChainContext`.
 *
 * State-zone classification ([L24]): the per-card key-view id, focusable records,
 * and mode stack are all **structure** zone (registry + `useLayoutEffect` at the
 * hook). The `data-key-view` attribute is the **appearance** projection of the
 * key view, written directly to the DOM ([L06]) -- never React state.
 */

import { createContext } from "react";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { deckTrace } from "@/deck-trace";
import type { TugAction } from "./action-vocabulary";
import type { ComponentKeyDeclaration, FocusKey } from "./focus-act";
import type { ResponderChainManager } from "./responder-chain";
import { resolveSpatial, type SpatialDirection, type SpatialOrder } from "./spatial-order";
import { revealFocusTarget } from "./focus-reveal";
import { resolveDefaultFocusTarget } from "@/default-focus";
import { getDeckStore } from "@/lib/deck-store-registry";
import { getRegistration } from "@/card-registry";
import { isFocusDestination } from "@/deck-store-selectors";
import type { DeckState } from "@/layout-tree";

/**
 * The behavior a key-view component declares to the engine ([P01]): the pure
 * decision fields the act resolver reads ({@link ComponentKeyDeclaration}) plus
 * the callbacks the engine invokes to carry an act out. The engine owns the
 * scope mechanics (ascend = pop); the component supplies the rest, so behavior
 * follows from the declaration rather than a bespoke per-component keymap.
 */
export interface KeyViewBehavior extends ComponentKeyDeclaration {
  /** Space: select / toggle the current item. Enter never commits a group member ([P24]). */
  onSelect?: () => void;
  /** A plain act on a leaf (Enter / Space on a non-item component). */
  onAct?: () => void;
  /** Enter on a descendable item: the component pushes its inner scope + lands the key view inside it. */
  onDescend?: () => void;
  /** Optional cleanup when the engine ascends out of this component's descended scope. */
  onAscend?: () => void;
  /**
   * Delegated key delivery ([P05] / Spec S04): the engine's replacement for an
   * element-attached keydown listener, which is structurally unreachable once
   * keys route from the engine's target (in engine-routed mode, keydown lands
   * on the key sink — a component subtree never sees it). Invoked by the
   * provider's document-capture `keyViewDelegateListener` via
   * {@link FocusManager.dispatchKeyToKeyView}, after the walk / spatial /
   * bindings / act stages have declined the key. Return `true` = handled (the
   * listener consumes the event), `false` = fall through. Never invoked in
   * dom-granted mode (the granted surface owns its keys) and never for ⌘/⌃
   * chords (those belong to the bindings).
   */
  onKey?: (event: KeyboardEvent) => boolean;
}

/**
 * The live delegation contract a selection-group key view exposes to the spatial
 * navigator ([P22] / [Q12]). The group is ONE ring node; when the ring rests on it,
 * an arrow that stays inside the group drives its `useFocusCursor` 1D cursor instead
 * of moving the ring, and only an arrow off the group's edge crosses a declared seam
 * to the next key view. The handle is appearance-only ([L06]): it moves the cursor
 * and fires any live commit; it never registers a focusable.
 */
export interface SpatialCursorHandle {
  /** Number of cursor positions (live; reflects enabled items). */
  length: () => number;
  /** Current cursor index (live), or `-1` when empty. */
  cursorIndex: () => number;
  /** Move the cursor by the resolver's delta (clamped) and fire the group's live commit, if any. */
  moveCursor: (delta: number) => void;
  /**
   * How many items the group puts on a row, when it is laid out as a grid. The
   * resolver reads it to make a vertical arrow step a whole row instead of one
   * item. Absent — the common case — means a 1D run.
   */
  columns?: () => number;
  /**
   * Which arrows the group claims ([P12]). `"both"` (the default) is the inline
   * shape — a chip group roves on all four. `"vertical"` is the stacked shape: a
   * one-column list, where the resolver's 1-D reading would otherwise make
   * ArrowLeft mean "cursor up". A horizontal arrow against a `"vertical"` group is
   * not the cursor's; it falls through to seam / ring / the liveliness net.
   */
  axis?: "vertical" | "both";
  /**
   * If `ArrowRight` should descend the current item (tree disclosure — an open
   * accordion section / a list row with navigable content), descend and return
   * `true`; else `false`. Consulted before spatial movement so Right keeps its
   * disclosure meaning wherever descent is available ([P02]).
   */
  tryDescendRight: () => boolean;
}

// ---- Focus target ----

/**
 * The one authoritative "where is the keyboard" value for a card — the
 * serializable descriptor every focus placement records and every projection
 * derives from. The union of the engine's historical registers (key view,
 * chain first responder, persisted focus bag) in one shape:
 *
 *  - `focusable` — a registered focus stop, by its live registry id.
 *  - `focus-key` — a registered focus stop, by its stable `group:order`
 *    focus key (the serialized / restore-time form; identical every mount,
 *    unlike per-render ids).
 *  - `responder` — a registered responder (an editor / substrate); focus
 *    lands through its `focus` contract so the caret is placed correctly.
 *  - `state-key` — a keyed form control, by its stable
 *    `data-tug-state-key` (the focus identity a `form-control` bag
 *    snapshot carries — implicit in its preservation key, [D10]).
 *  - `engine` — the card's engine-owned text surface (an em card); focus
 *    lands through the card's registered engine hook.
 *  - `none` — no focus destination; placement is a definitive no-op.
 */
export type FocusTarget =
  | { kind: "focusable"; id: string }
  | { kind: "focus-key"; focusKey: string }
  | { kind: "state-key"; key: string }
  | { kind: "responder"; responderId: string }
  | { kind: "engine" }
  | { kind: "none" };

/** The input modality a placement asserts — which flavor of projection the
 *  ring reads (`keyboard` paints it, `pointer` does not). */
export type FocusModality = "keyboard" | "pointer";

/**
 * The keyboard route of a placement — derived structurally from the
 * {@link FocusTarget} kind plus the responder registry, never a per-call flag:
 *
 *  - `dom-granted` — the target is a real text surface (an `engine` card
 *    editor, a `state-key` native form control, or a `responder` whose
 *    substrate registered a `focus` contract — the CM6 editors). Such a
 *    surface genuinely needs the platform focus register (caret, IME,
 *    composition, native selection), so DOM focus is granted to it.
 *  - `engine-routed` — everything else (`focusable`, `focus-key`, a
 *    `responder` without a focus contract, `none`). Keys route from the
 *    engine's own target; `document.activeElement` is parked on the key
 *    sink and carries no routing authority.
 */
export type KeyboardRoute = "engine-routed" | "dom-granted";

/**
 * DOM marker of an engine-owned key sink — a visually-hidden focusable
 * element the engine parks `document.activeElement` on while the keyboard
 * route is `engine-routed`; a deterministic, checkable identity for "the
 * keyboard is engine-owned" (`<body>` cannot carry a role or a quiet
 * label). `ResponderChainProvider` renders the always-mounted root sink; a
 * surface that JAILS focus (a Radix-modal trap, whose FocusScope refocuses
 * into itself whenever focus leaves it) hosts its own sink inside the jail
 * so parking never crosses the jailer's boundary. The engine parks at the
 * INNERMOST sink (last in document order — portaled surfaces append), and
 * any sink is a legal park.
 */
export const KEY_SINK_ATTRIBUTE = "data-tug-key-sink";

/** Options for {@link FocusManager.place}. */
/**
 * How the keyboard ARRIVED at a target — a property of the placement, not of
 * engine state, and the input that decides whether a text stop parks ([P12],
 * Spec S05).
 *
 * - `"movement"` — the engine walked here: a spatial step, a linear step, the
 *   Tab walk. The user asked to *move the ring*, not to type, so a text stop
 *   reached this way is **parked**: ringed, with no caret, until Return or a
 *   printable character grants one.
 * - `"placement"` (the default) — everything else: a surface seeding its own
 *   key view (`useSeedKeyView`), an explicit `realizeTarget` from a surface, a
 *   commit-home seed, a pointer placement, a restore. These are declarations of
 *   a text-first entry point and they **grant** the caret. Without the
 *   distinction every text-first sheet in the app — rename, resume, the session
 *   question dialog — would open ringed and caret-less.
 *
 * Carried explicitly rather than inferred. An inference over "did the key view
 * change by one step" is exactly the ambient-predicate class this mode exists
 * to delete.
 */
export type FocusArrival = "movement" | "placement";

export interface PlaceOptions {
  /**
   * How the keyboard arrived ({@link FocusArrival}). Defaults to
   * `"placement"`, so only the movement performers that opt in can park a
   * text stop.
   */
  arrival?: FocusArrival;
  /**
   * The modality this placement asserts. Defaults to the engine's input
   * latch (the last real user input source). A programmatic restore that
   * must re-light the ring passes `"keyboard"` explicitly.
   */
  modality?: FocusModality;
  /**
   * `true` only from the activation channel: names `cardId` the key card
   * before realizing the target, so activation = "swap the card's target
   * in, project once".
   */
  activation?: boolean;
  /**
   * Focus without scrolling the target into view — for reactivation-class
   * restores where the user's scroll position must survive ([L23]). The
   * registry-kind realizations always `preventScroll` ([D07]); this flag
   * extends that to the `state-key` DOM focus.
   */
  preventScroll?: boolean;
}

/**
 * Result of a {@link FocusManager.place} call. Placement is TRANSACTIONAL
 * ([P06]): `realizeTarget` resolves the target to a live destination FIRST
 * and only then commits (key view, ring projection, keyboard route, focus
 * move — one pass). There is no partial outcome: either the whole commit
 * ran (`"placed"`), or nothing painted and the previous target's key view,
 * ring, and route all stand (`"recorded"` / `"unrealized"`).
 */
export type PlaceResult =
  /** The target resolved and committed: key view set, ring projected,
   *  route classified, DOM focus moved. */
  | "placed"
  /** `cardId` is not the key card: the target was recorded in that card's
   *  context (registry kinds also realize their CACHE half — key view +
   *  route, both projection-gated), no DOM side effects; projected on the
   *  card's next activation ([P20]). */
  | "recorded"
  /** Resolution failed — the target names a registration/element that is
   *  not present or not rendered. Nothing painted, no route change; the
   *  record stands, and a keyboard `focus-key` placement arms
   *  `pendingRealizeKey` so a matching late mount re-runs the placement. */
  | "unrealized";

// ---- Focus modes ----

/**
 * The id of the base focus mode -- the bottom of a context's mode stack, always
 * present, never pushed or popped. Focusables that do not belong to a
 * floating surface register into this mode; the Tab walk services it
 * whenever no trapped mode is current.
 */
export const BASE_FOCUS_MODE = "base";

/**
 * Compact one-line description of an element for focus-invariant reports:
 * tag, id, the focus-identity attributes, and the first couple of classes —
 * enough to name the element in a log line without dumping the node.
 */
/**
 * A key that moves a cursor rather than naming a command — the set ⌘ is allowed
 * to carry through to a key view's `onKey` delegate. Deliberately does not
 * include Page keys: a screenful is a scroll, and scrolling with ⌘ held is not
 * a gesture anything asks for.
 */
function isMovementKey(key: string): boolean {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Home" ||
    key === "End"
  );
}

function describeElementForInvariant(el: Element | null): string {
  if (el === null) return "(nothing)";
  const tag = el.tagName.toLowerCase();
  const id = el.id !== "" ? `#${el.id}` : "";
  const focusable = el.getAttribute("data-tug-focusable");
  const responder = el.getAttribute("data-responder-id");
  const identity =
    focusable !== null
      ? `[data-tug-focusable="${focusable}"]`
      : responder !== null
        ? `[data-responder-id="${responder}"]`
        : "";
  const classes =
    el.classList.length > 0
      ? `.${[...el.classList].slice(0, 2).join(".")}`
      : "";
  return `${tag}${id}${identity}${classes}` || tag;
}

/** Escape an id for use inside a `[attr="..."]` selector. Falls back to the raw
 *  id where `CSS.escape` is unavailable (older/headless environments). */
function cssEscapeId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id;
}

/**
 * DOM projection of the current (top) focus mode, stamped on the document root.
 * Absent when the base mode is current; set to the active trap's scope id while
 * a floating surface's mode is pushed. The appearance/structure projection of
 * the mode stack ([L24]) — useful for CSS that scopes to "a modal trap is
 * active", for devtools, and for app-tests. Mirrors `data-key-view` /
 * `data-keyboard-access`. Projected only by the **key card's** context.
 */
export const FOCUS_MODE_ATTRIBUTE = "data-focus-mode";

/**
 * DOM projection of **KBF mode's paint** on the document root: present (empty
 * value) while the mode is engaged AND painting, absent otherwise. The mode's
 * one public mark ([P02]).
 *
 * The attribute answers *is the mode painting*, not *is the mode on* — the two
 * diverge exactly while a caret is live: a granted caret stands the mode's
 * whole visual vocabulary down (a blinking caret and a focus ring are mutually
 * exclusive), while the mode itself stays engaged and the next park brings the
 * paint back. JS asks the truth question of {@link FocusManager.kbfEngaged};
 * the DOM wears the paint answer, {@link FocusManager.kbfPainting}. Both are
 * derived, never latched.
 *
 * CSS selects on it as `html:not([data-kbf])` suppressions only, anchored the
 * way the `data-app-active` rule in `focus-ring.css` is; the ring's own trigger
 * (`data-key-view-kbd`) is withheld at the projection instead, so no painting
 * rule's specificity changes.
 */
export const KBF_ATTRIBUTE = "data-kbf";

/**
 * DOM marker for the **immediate container** of the key view (depth 1 only):
 * the element one level up the key path that *contains* the active component.
 * The engine's visible `:focus-within` — a quiet "contains active" mark, distinct
 * from the focus ring (`data-key-view-kbd`, on the component itself) and the
 * movement cursor (`data-key-cursor`, on the current item). Projected from the
 * scope stack: when a scope is descended into (pushed), the key view captured at
 * push time (`restoreKeyView` — the container we descended *from*) wears it.
 * Only the top scope's container is marked; no ancestor chain renders.
 */
export const KEY_WITHIN_ATTRIBUTE = "data-key-within";

/**
 * DOM marker naming the engine's key view — the element the keyboard is on,
 * carrying the focusable id as its value. Modality-agnostic; the `-kbd` variant
 * beside it is the one that paints a ring.
 */
export const KEY_VIEW_ATTRIBUTE = "data-key-view";

/**
 * DOM marker a focused text surface sets on (or within) itself to advertise
 * "I own Tab right now" -- e.g. a text editor with an open completion popup,
 * which accepts the completion on Tab instead of yielding to the focus walk.
 * The Tab pipeline checks this before advancing the key view (the [Q02]
 * flag resolution): when present on the active element's subtree, Tab is left
 * to the surface's own keymap; otherwise the focus walk advances.
 */
export const TAB_CONSUME_ATTRIBUTE = "data-tug-tab-consume";

/**
 * The opposite declaration: a multi-line text surface stating "Tab is **not**
 * mine — walk." Set by a `TugTextEditor` mounted with `tabMovesFocus`.
 *
 * It exists because the Tab pipeline's yield test is deliberately STRUCTURAL:
 * a contentEditable or `TEXTAREA` owns Tab by virtue of being multi-line, since
 * indent is a real meaning it has. That is the right default and it is why a
 * composer eats Tab. But a short answer field inside a dialog is multi-line for
 * wrapping, not for indenting — its Tab has to reach the dialog's buttons, or
 * the field is a jail with no way out but the mouse.
 *
 * The absence of {@link TAB_CONSUME_ATTRIBUTE} could not say this: the
 * structural test runs whether or not that marker is present, so a
 * `tabMovesFocus` field still swallowed Tab into an indent. Only a positive
 * declaration, checked FIRST, can release it — the surface is the one that
 * knows.
 */
export const TAB_RELEASE_ATTRIBUTE = "data-tug-tab-release";

/**
 * DOM marker a text field sets on the wrapper **containing** its `<input>` to
 * declare an **attached list** ([P08], Spec S02): while the caret is inside,
 * ↑/↓ drive that list's cursor and never leave the field.
 *
 * The same class of declaration as {@link TAB_CONSUME_ATTRIBUTE} — a component
 * contract projected into the DOM for the document ladder to read ([L24]),
 * not appearance. The marker rides the wrapper rather than the input because
 * the active element IS the inner input; the ladder tests containment
 * (`closest`), the way every other in-key-view test does.
 *
 * It holds in **both** KBF modes and regardless of whether the field is empty.
 * That unconditionality is the point: it is the replacement for the ambient
 * empty-input arrow release, which decided the same question from the field's
 * content on every keystroke.
 */
export const ATTACHED_LIST_ATTRIBUTE = "data-tug-attached-list";

/**
 * The highlight an **attached list** wears on the row its field's ↑/↓ have
 * cursored to ([P08]).
 *
 * Deliberately NOT `data-key-cursor`, for two reasons that both come down to
 * this being a different mark rather than the same one somewhere else:
 *
 *  - The engine's movement cursor paints only while the keyboard is *in* that
 *    list (it holds the key view, or a row of it is descended into). An
 *    attached list never holds the key view — the caret is in the field — so
 *    the movement cursor's own gating would suppress it.
 *  - `data-key-cursor` is suppressed outright in mode OFF ([P04]), and an
 *    attached list is at its most load-bearing exactly there: a caret in a
 *    filter, driving rows, with the mode off. Like `data-default-ring`, this
 *    mark is **exempt** from the mode gate, because it is not a focus position
 *    — it is a text field's statement about which row its next Return means.
 */
export const ATTACHED_CURSOR_ATTRIBUTE = "data-attached-cursor";

/**
 * The part of the projection derived from a single context's state — no deck
 * globals, no DOM. Split out from {@link FocusProjection} so the derivation can
 * be compared across a state round trip without a document.
 */
export interface FocusProjectionState {
  keyViewId: string | null;
  keyViewKeyboard: boolean;
  keyWithinId: string | null;
  /** `null` at the base mode; the trap's scope id while one is pushed. */
  focusMode: string | null;
  route: KeyboardRoute;
}

/**
 * The complete DOM projection of engine state: every focus mark, plus the one
 * legal `document.activeElement`, derived by a single pure computation.
 *
 * Engine state is the truth and this is its write-through image. Nothing here
 * is read back as truth — {@link FocusManager.reproject} applies it, and the
 * watchdog reconciles the DOM against it. The `*Id` fields come from
 * {@link FocusProjectionState}; the element fields are those ids resolved
 * against the live document (all `null` in a DOM-free environment).
 */
export interface FocusProjection extends FocusProjectionState {
  /** The element that should carry `data-key-view`. */
  keyViewEl: HTMLElement | null;
  /** Whether that element should also carry `data-key-view-kbd`. */
  keyViewKbd: boolean;
  /**
   * Whether KBF mode is **painting** — engaged with the paint standing, the
   * bit projected as {@link KBF_ATTRIBUTE} on the document root. Derived,
   * never stored; see {@link FocusManager.kbfPainting}.
   */
  kbf: boolean;
  /** The element that should carry `data-key-within`. */
  keyWithinEl: HTMLElement | null;
  /** The element that should carry `data-default-ring`. */
  defaultRingEl: HTMLElement | null;
  /**
   * The one legal `activeElement` for this state. `null` under `dom-granted`
   * means the granted surface is GONE — the incoherence case the watchdog
   * reports rather than corrects.
   */
  legalActive: HTMLElement | null;
}

/**
 * A focus mode (scope) on a context's stack. Mirrors a CFRunLoop mode: while it
 * is current, the Tab walk services only the focusables registered into it
 * ({@link FocusContext.walkModeSet}) — a focus trap for free, for EVERY pushed
 * mode.
 *
 * `trapped` does NOT widen the Tab walk; it selects the Escape semantics:
 * - `trapped: true` -- modal. Escape DISMISSES the surface (sheet / alert /
 *   popover / menu) — the surface owns its own Escape (cancel) and the engine must
 *   not pop it from under it ([R04]). A focus-cycle is the one trapped mode that
 *   opts OUT of this via `escapeExits` (see {@link FocusModeEntry}): it has no
 *   surface to own Escape, so Escape pops the cycle back to rest instead.
 * - `trapped: false` -- a descend scope (an accordion section, a list row).
 *   Escape ASCENDS one level instead of dismissing. Tab is still contained to
 *   this scope's focusables (a locked loop) — see {@link FocusContext.walkModeSet}.
 */
export interface FocusMode {
  scopeId: string;
  trapped: boolean;
}

/**
 * Whether a keyboard value-commit at a cycle stop keeps the cycle (`retain`) or
 * pops it back to the resting key view (`relinquish`) — [P15] of the
 * focus-language plan. The disposition is carried by the focus *mode* (set by
 * whichever primitive pushed it), so the act dispatch stays policy-agnostic.
 */
export type CycleDisposition = "retain" | "relinquish";

/** The act-dispatch commit kinds that a mode's `commitDisposition` reacts to. */
export type FocusCommitKind = "select" | "act" | "descend";

/** The commit a mode's `commitDisposition` is consulted with. */
export interface FocusCommit {
  kind: FocusCommitKind;
  /** The key view (stop) that committed, for per-stop override decisions. */
  keyViewId: string | null;
}

/**
 * Internal mode-stack entry. Adds `restoreKeyView`: the key view that was
 * current when this mode was pushed, restored when it is popped — the
 * CFRunLoop "pop restores the prior key view" semantic ([#cfrunloop-model]).
 * `restoreKeyViewKeyboard` snapshots whether that key view was keyboard-driven,
 * so the restore re-paints the ring iff it was there before the push (e.g. a
 * popover opened by keyboard from a focus-cycling stop returns to the ringed
 * stop on close; a mouse-opened one restores ringless).
 * `commitDisposition` ([P15]): consulted when a stop commits a value by
 * keyboard while this mode is current; `relinquish` pops the mode.
 * `escapeExits`: opt a trapped mode into "Escape pops me back to rest" — a
 * self-contained focus-cycle, as opposed to a modal surface that owns its own
 * Escape. When set, a bare Escape at this mode (the current top) runs
 * {@link FocusContext.escapeCurrentMode} instead of leaving Escape to a surface's
 * cancel ([R04]).
 */
interface FocusModeEntry extends FocusMode {
  restoreKeyView: string | null;
  restoreKeyViewKeyboard: boolean;
  commitDisposition?: (commit: FocusCommit) => CycleDisposition;
  escapeExits?: boolean;
  /**
   * Opt a dismissable popover into "Space also closes me" — the symmetric
   * partner to the Space that opened it from its trigger leaf. Consulted by the
   * act dispatch: a Space that lands on the popover's own (non-interactive)
   * chrome runs {@link FocusModeEntry.onEscapeDismiss}, while a Space on an
   * interactive control inside keeps its native press / select. Set only by
   * info popovers (Z2 cells, the beat, the route report); unset for modal confirm
   * popovers, menus, and pickers, whose Space belongs to their content.
   */
  spaceDismisses?: boolean;
  /**
   * The chain's first responder when this mode was pushed — the SECOND axis of the
   * CFRunLoop restore, alongside `restoreKeyView`. DOM focus, the key view, and the
   * first responder are all projections of one focus state; a trapped surface (a
   * modal confirm popover) may displace the first responder on open — it claims it
   * via `makeFirstResponder` so its own Cmd-. cancel reaches it, since its refuse
   * buttons never promote — so on pop the stack restores this captured responder
   * and action dispatch returns to where the user was. Without it a
   * first-responder-routed accelerator (Cmd-.) keeps landing on the closed surface.
   * `null` when nothing held first responder at push.
   */
  restoreFirstResponder: string | null;
  /**
   * The surface's own dismiss action, registered at push by a user-dismissable
   * trapped surface (popover, sheet, alert, dialogs, menus). When the engine's
   * Escape ladder selects "dismiss the top surface" it calls this and consumes
   * the event; what the callback does is the surface's business (a controlled
   * Radix flip, a chain `CANCEL_DIALOG` dispatch, or a synthesized Escape). The
   * mode stack owns *which* surface is on top; the callback owns *how* it closes
   * ([P01]). `undefined` for modes the engine closes structurally (a focus-cycle
   * via `escapeExits`, a non-trapped descend scope via `ascend`).
   */
  onEscapeDismiss?: () => void;
  /**
   * Whether this mode entry auto-engages KBF mode while it is on the stack —
   * Class A of the derivation (Spec S01). Defaults to engaging; a typing-first
   * surface that traps the keyboard but wants text ownership (Open Quickly's
   * completion popup) passes `false`.
   *
   * Only consulted for `trapped` entries: a non-trapped descend scope is
   * navigation inside a surface, not a surface appearing, and never engages.
   */
  kbf?: boolean;
}

// ---- Focusables ----

/**
 * Walk policy for a focusable.
 *
 * - `accept` -- included in the standard-mode Tab walk.
 * - `skip` -- pointer-focusable but excluded from the standard walk; included
 *   only in `accessibility` keyboard-access mode.
 */
export type FocusPolicy = "accept" | "skip";

/**
 * Keyboard-access mode. `standard` honors `skip`; `accessibility` ignores it
 * so every interactive affordance is Tab-reachable. The mode is owned by a
 * tugbank-backed store (wired separately) and is **deck-global** (the coordinator
 * holds it; every context's walk reads it).
 */
export type KeyboardAccessMode = "standard" | "accessibility";

/**
 * The shape a caller (the `useFocusable` hook, or a test) hands to
 * `registerFocusable`. `policy` and `modes` are optional and normalized to
 * their defaults inside the context.
 */
export interface FocusableInput {
  /** Stable id for this focusable. Matches the `data-tug-focusable` attribute. */
  id: string;
  /**
   * Named focus group. Tab order is group-level authored ([P02]): the walk
   * sorts by (group ordinal, item order), where group ordinals come from
   * `setGroupOrder`. Groups not in the authored order sort after the named
   * ones, by registration sequence.
   */
  group: string;
  /** Item order within the group. */
  order: number;
  /** Walk policy. Defaults to `accept`. */
  policy?: FocusPolicy;
  /**
   * Transient "I consume Tab right now" predicate (e.g. a text editor with an
   * open completion popup). Consulted by the Tab pipeline before advancing
   * the key view. Stored by reference so the hook can keep it live without
   * re-registering.
   */
  consumesTab?: () => boolean;
  /**
   * The component's key-view behavior ([P01]), held by reference and read live at
   * dispatch time so a component can change what its current item descends to (or
   * which keys it captures) without re-registering. Absent for plain focus stops
   * that need no model dispatch.
   */
  behavior?: () => KeyViewBehavior | null;
  /**
   * The focus modes this focusable participates in. Defaults to
   * `[BASE_FOCUS_MODE]`. Floating surfaces register their contents into the
   * mode they push.
   */
  modes?: string[];
}

/**
 * A normalized focusable record held in a context's registry. `policy` and
 * `modes` are filled in; `seq` is a monotonic registration counter used as the
 * final sort tiebreak so the walk order is deterministic.
 */
export interface FocusableRecord {
  id: string;
  group: string;
  order: number;
  policy: FocusPolicy;
  consumesTab?: () => boolean;
  behavior?: () => KeyViewBehavior | null;
  modes: string[];
  seq: number;
}

// ---- FocusContext ----

/**
 * One card's self-contained focus universe ([P21]). Owns the focusable registry,
 * the focus-mode stack, the key view (id + keyboard-ness), the key-within, the
 * default-ring stack, and the group order + default-action map. All of the walk,
 * seed, mode, and DOM-projection logic operates on *this* context.
 *
 * It reads deck-global settings (keyboard-access mode, ring modality) and the
 * "am I the key card?" gate from its coordinator ({@link FocusManager}), and
 * notifies the coordinator's single global subscriber set on change. **Only the
 * key card's context projects to the DOM**: {@link FocusContext.reproject} is a
 * no-op when this context is not active, so a background card mutating its own
 * stack (a dialog mounting at `display:none`) never clobbers the active card's
 * marks.
 *
 * A context does not write marks itself. It contributes
 * {@link FocusContext.projectionState} — its share of the derivation — and the
 * coordinator computes the whole projection and converges the DOM onto it
 * ({@link FocusManager.computeProjection} / {@link FocusManager.reproject}).
 */
export class FocusContext {
  private focusables: Map<string, FocusableRecord> = new Map();
  private modeStack: FocusModeEntry[] = [];
  private groupOrder: string[] = [];
  private defaultActions: Map<string, TugAction> = new Map();
  private keyViewId: string | null = null;
  // Whether the current key view was reached by *keyboard* (the Tab walk /
  // surface entry) vs by pointer (click promotion). The focus ring shows on a
  // keyboard-reached key view; WebKit's `:focus-visible` heuristic is
  // unreliable for the engine's programmatic `.focus()`, so the engine marks
  // its own keyboard navigation rather than depending on the browser.
  private keyViewKeyboard = false;

  // Reveal suppression for the current realization: set while a
  // `preventScroll` placement runs, so the keyboard key view it writes rings
  // where it is instead of scrolling the surface out from under a
  // reactivation-class restore ([L23]).
  private revealSuppressed = false;
  // Stack of buttons that have opted into the persistent default ring (the
  // "Return's home" filled+ring shown while the keyboard rests on a non-button
  // control). The engine owns the `data-default-ring` DOM attribute so the
  // one-filled-ring-per-scope invariant ([P14]) is structural: the TOP node
  // wears the ring iff the current key view is NOT itself a button. Per-card.
  private defaultRingStack: HTMLElement[] = [];
  private seqCounter = 0;
  // Declared spatial arrow orders ([P23] / [Q12]), keyed by the focus mode
  // (`scopeId`) they govern — a card's base order, a dialog trap's own order. The
  // navigator looks up the order for the current mode; pure ring/seam/override data
  // (structure zone, [L22]). Group nodes are discovered live from `cursorHandles`,
  // not declared here.
  private spatialOrders: Map<string, SpatialOrder> = new Map();
  // Live cursor handles for selection-group key views (the [Q12] delegation
  // contract). Present only while a group is mounted; the navigator consults the
  // ringed node's handle to delegate an in-group arrow to the cursor.
  private cursorHandles: Map<string, SpatialCursorHandle> = new Map();
  // Dev-only: dead-arrow reachability warnings ([R06]) already emitted, keyed by
  // `mode|node|direction`, so a held / repeated arrow into an undeclared direction
  // reports its authoring gap once instead of spamming the dev log.
  private warnedDeadArrows = new Set<string>();

  constructor(
    private readonly coord: FocusManager,
    /** The card this context belongs to, or `null` for the default context. */
    readonly cardId: string | null,
  ) {}

  // ---- Coordinator-facing gates / settings ----

  /** Whether this context is the key card's context (the only one that projects). */
  private isActive(): boolean {
    return this.coord.isActiveContext(this);
  }

  // ---- Focusable registry ----

  /**
   * Register (or replace) a focusable. Normalizes `policy` to `accept` and
   * `modes` to `[BASE_FOCUS_MODE]`, and assigns a registration sequence used
   * as the final walk-order tiebreak.
   */
  registerFocusable(input: FocusableInput): void {
    const record: FocusableRecord = {
      id: input.id,
      group: input.group,
      order: input.order,
      policy: input.policy ?? "accept",
      consumesTab: input.consumesTab,
      behavior: input.behavior,
      modes: input.modes ?? [BASE_FOCUS_MODE],
      seq: this.seqCounter++,
    };
    this.focusables.set(record.id, record);
    this.notify();
    // Declarative late-mount realization: the context's recorded focus
    // target names a `focus-key` whose focusable wasn't mounted at
    // placement time; this registration may be it. Re-running the placement
    // (not a bespoke ring resume) keeps the one-primitive rule — the
    // realization is the same atomic pass, and nothing derives state from
    // the `focusin` it fires (the watchdog only ever enforces engine state
    // onto the register).
    if (
      this.pendingRealizeKey !== null &&
      record.group !== "" &&
      `${record.group}:${record.order}` === this.pendingRealizeKey &&
      this.isRecordRendered(record)
    ) {
      // Realize against THIS context (self-gating: a background context
      // updates its cache only). Registration is not user input, so the
      // input latch is untouched.
      this.realizeTarget(
        { kind: "focus-key", focusKey: this.pendingRealizeKey },
        "keyboard",
      );
    }
  }

  /** Remove a focusable. No-op if it is not registered. */
  unregisterFocusable(id: string): void {
    if (this.focusables.delete(id)) {
      this.notify();
    }
  }

  /**
   * Author the group sequence for the Tab walk ([P02]). Groups appear in Tab
   * order in the order given; groups not listed sort after the named ones, by
   * registration sequence. Reordering this list reorders the walk with no DOM
   * move.
   */
  setGroupOrder(groups: string[]): void {
    this.groupOrder = [...groups];
    this.notify();
  }

  // ---- Key view ----

  /**
   * Set the key view to `id` (or `null` to clear). Writes the `data-key-view`
   * DOM attribute on exactly one element, plus `data-key-view-kbd` when the key
   * view was reached by keyboard (so the focus ring paints) — but only while this
   * context is the key card's (projection is gated on active). No-op (other than
   * the DOM sync) when neither the value nor the modality changed.
   *
   * `keyboard` defaults to `false` (pointer / chain reflection); the Tab walk
   * and surface entry pass `true`.
   *
   * A keyboard key view is REVEALED: a ring the user cannot see is not a focus
   * mark, so the new key view is scrolled into view by its owning scrollports
   * ({@link revealFocusTarget}). The early return above is what keeps this to
   * one reveal per move — a re-assertion of the same `(id, keyboard)` pair
   * never re-scrolls. Suppressed under `preventScroll` realizations, where the
   * user's scroll position must survive the placement ([L23]).
   */
  setKeyView(id: string | null, keyboard = false): void {
    if (this.keyViewId === id && this.keyViewKeyboard === keyboard) return;
    this.keyViewId = id;
    this.keyViewKeyboard = keyboard;
    this.reproject();
    if (keyboard && !this.revealSuppressed && this.isActive()) {
      const el = this.keyViewElement();
      if (el !== null) revealFocusTarget(el);
    }
    this.notify();
  }

  /**
   * Re-project the current key view onto the DOM element that now carries its
   * `data-tug-focusable` — for a **roving single-stop focusable** (a tab bar,
   * radio / option / choice group, accordion, or list) whose key-view *id* stays
   * the same while the projected element moves under arrow navigation.
   * `setKeyView` early-returns when `(id, keyboard)` is unchanged, so it cannot
   * chase a moved element; this re-runs the DOM projection directly.
   *
   * `keyboard` sets the modality the ring reads: `true` (arrow-roving) keeps the
   * ring on the newly-roved member; `false` (a pointer move within the group)
   * clears it; omit to preserve the current modality.
   */
  refreshKeyViewProjection(keyboard?: boolean): void {
    if (this.keyViewId === null) return;
    if (keyboard !== undefined) this.keyViewKeyboard = keyboard;
    this.reproject();
  }

  /** The current key-view id, or `null` if none. */
  keyView(): string | null {
    return this.keyViewId;
  }

  /**
   * Whether the current key view is keyboard-driven (wears the ring). A floating
   * surface's close-focus restorer uses this at open time to decide ownership:
   * when a keyboard key view is present, the engine's mode-stack restore owns the
   * close-focus (it returns the ring + DOM focus to that key view), so the
   * responder-chain "prior responder" restore must defer — one writer, not two.
   */
  keyViewIsKeyboard(): boolean {
    return this.keyViewKeyboard;
  }

  /**
   * Whether the current key view's focusable declares it is consuming Tab right
   * now (its `consumesTab` predicate returns true).
   */
  keyViewConsumesTab(): boolean {
    if (this.keyViewId === null) return false;
    return this.focusables.get(this.keyViewId)?.consumesTab?.() ?? false;
  }

  /**
   * The behavior declared by the current key view's component ([P01]), or `null`
   * when the key view declares none (a plain focus stop). The act-dispatch reads
   * this to resolve Space/Enter/Escape against the focused component.
   */
  keyViewBehavior(): KeyViewBehavior | null {
    if (this.keyViewId === null) return null;
    return this.focusables.get(this.keyViewId)?.behavior?.() ?? null;
  }

  /**
   * Whether the current key view captures `key` for itself (an editor leaf's
   * typing / caret) — the generalization of `keyViewConsumesTab` to any key
   * ([P04]). When true the act-dispatch leaves the key to the component. Falls
   * back to the `consumesTab` predicate for the Tab key so the two stay in sync.
   */
  keyViewCaptures(key: FocusKey): boolean {
    const captured = this.keyViewBehavior()?.captures?.(key) ?? false;
    if (captured) return true;
    return key.key === "Tab" ? this.keyViewConsumesTab() : false;
  }

  /**
   * Deliver a key to the current key view's `onKey` delegate (Spec S04) —
   * the delegation half of [P05]. Tries the key view's own behavior first;
   * while descended into a NON-trapped scope (a list row), falls back one
   * level to the behavior of the container the scope was descended from
   * (`restoreKeyView`). That fallback is the honest replacement for the
   * container's element-capture listener, which used to see a descendant's
   * keydown only because the event bubbled through its DOM subtree —
   * delivery the engine now provides explicitly (ArrowLeft-ascend, Home/End
   * from inside a row scope). Returns whether a delegate handled the key.
   */
  dispatchKeyToKeyView(event: KeyboardEvent): boolean {
    const behavior = this.keyViewBehavior();
    if (behavior?.onKey?.(event) === true) return true;
    const top = this.modeStack[this.modeStack.length - 1];
    if (
      top !== undefined &&
      !top.trapped &&
      top.restoreKeyView !== null &&
      top.restoreKeyView !== this.keyViewId
    ) {
      const container =
        this.focusables.get(top.restoreKeyView)?.behavior?.() ?? null;
      if (container?.onKey?.(event) === true) return true;
    }
    return false;
  }

  /**
   * Ascend one scope level: pop the current (top) focus mode, restoring the key
   * view captured when it was pushed, and move DOM focus to it. The engine half
   * of Escape ([P02]); a no-op (returns `false`) at the base mode, so a bare
   * Escape with nothing descended falls through to the cancel ladder ([R04]).
   */
  ascend(): boolean {
    const mode = this.currentFocusMode();
    if (mode === BASE_FOCUS_MODE) return false;
    this.popFocusMode(mode);
    // `popFocusMode` restores the prior key view with `keyboard=false`; we
    // ascended by keyboard, so re-stamp the ring onto the restored container.
    this.refreshKeyViewProjection(true);
    this.focusKeyView();
    return true;
  }

  /**
   * Exit the current trapped mode that opted into Escape-exit (`escapeExits`) — a
   * self-contained focus-cycle, as opposed to a modal surface that owns its own
   * Escape (cancel). Pops the mode and restores the prior key view (the caret the
   * cycle captured at entry), mirroring the cycle's ⌥⇥ toggle-off
   * (`popFocusMode` + `focusKeyView`) — and unlike {@link ascend}, it restores
   * with the captured modality rather than forcing the ring, so a return to a
   * non-keyboard resting view (the prompt editor) lands ringless. The consumer
   * lands its resting destination off the `cycling` flip (its `restingFocus`).
   * No-op (returns `false`) when the current mode did not opt in — a modal surface
   * keeps its own Escape ([R04]).
   */
  escapeCurrentMode(): boolean {
    const top = this.modeStack[this.modeStack.length - 1];
    if (top === undefined || top.escapeExits !== true) return false;
    this.popFocusMode(top.scopeId);
    this.focusKeyView();
    return true;
  }

  /**
   * Re-assert this context's key view as a KEYBOARD destination — the landing
   * half of a keyboard-driven activation (Cmd-L, pane cycling) on a card whose
   * retained key view may have been left by a pointer. The position does not
   * move: the key view (and any descended scope) stays exactly where the card
   * remembers it; only the modality is asserted, so the ring paints, the
   * engine reveals it, and the keyboard lands. A keyboard gesture that
   * activates a card must SHOW where the keyboard went — a retained pointer
   * key view replayed as-is is an invisible focus mark, and an invisible mark
   * reads as drift.
   *
   * Stale state heals first, so a ring is never asserted over a destination
   * that is not there: a non-trapped descended scope whose key view no longer
   * resolves (its row re-rendered away while the card was in the background)
   * ascends level by level until a live view is found, and a dead key view at
   * the bottom clears to `null`. Trapped modes are never popped — a dialog
   * owns itself, even while its focusable mounts late.
   *
   * Returns whether a live key view holds the keyboard after the pass; on
   * `false` the caller's resolution (saved snapshot, default walk) should land
   * a destination of its own.
   */
  assertKeyboardDestination(): boolean {
    while (this.keyViewId !== null && this.keyViewElement() === null) {
      const top = this.modeStack[this.modeStack.length - 1];
      if (top !== undefined && !top.trapped) {
        this.popFocusMode(top.scopeId, { moveDomFocus: false });
        continue;
      }
      if (top === undefined) {
        this.setKeyView(null);
      }
      break;
    }
    if (this.keyViewId === null || this.keyViewElement() === null) return false;
    // Assert the modality directly rather than through `setKeyView`, whose
    // unchanged-pair early return would skip the reveal: a Cmd-L return must
    // show the ring even when the key view was already keyboard-flavored.
    this.keyViewKeyboard = true;
    this.reproject();
    if (!this.revealSuppressed && this.isActive()) {
      const el = this.keyViewElement();
      if (el !== null) revealFocusTarget(el);
    }
    this.focusKeyView();
    this.notify();
    return true;
  }

  /**
   * Land the KEYBOARD for the current key view, per its route ([P01]/[P04]):
   * a dom-granted key view (a responder with a focus contract — a text
   * surface) is GRANTED real DOM focus via {@link grantTextSurface}; an
   * engine-routed key view parks `document.activeElement` on the key sink —
   * keys route from the engine's target either way, so the park is hygiene,
   * not a routing precondition. Re-derives the route from the current key
   * view first, so restore paths (ascend / mode pop / cycle exit) that write
   * the key view directly stay route-coherent without a placement.
   *
   * Gated on active: only the key card's context lands the keyboard, so a
   * background card popping a mode (its dialog unmounting) never steals
   * focus from the card the user is in. Returns whether the keyboard landed.
   */
  focusKeyView(): boolean {
    if (!this.isActive()) return false;
    if (this.keyViewId !== null) {
      // The same predicate `classifyRoute` applies, and it must give the same
      // answer: these two derivations diverging is how a stop ends up ringed by
      // one and granted by the other ([P12], Spec S05).
      //
      // Derived ABOVE the document guard below, deliberately: the route is
      // engine state — it is what `dispatchKeyToKeyView` gates on — not a DOM
      // effect, so it must settle whether or not there is a document to land
      // the keyboard in. Deriving it after the guard left the route frozen at
      // the old mode's answer in every DOM-free context.
      this.setRoute(
        this.coord.responderHasFocusContract(this.keyViewId) &&
          !this.parksTextStop()
          ? "dom-granted"
          : "engine-routed",
      );
    }
    if (typeof document === "undefined") return false;
    if (this.route === "dom-granted") return this.grantTextSurface();
    // A key view that resolves to a bare native text control (an
    // <input>/<textarea>/<select> with no contract-bound responder) is a
    // text surface by nature: GRANT it real DOM focus rather than park
    // the sink. It is exactly the element class the watchdog treats as a
    // legal focus holder (isBareNativeControl), so grant and legality
    // stay symmetric. Without this the sink parks and the native field
    // never receives a caret — a second focus authority (a Radix
    // FocusScope mount-autofocus, the browser's own default) fills the
    // vacuum, and the ring (engine key view) and the caret (that other
    // authority) split across two elements. grantTextSurface's generic
    // branch focuses the intrinsically-focusable element and is
    // idempotent when it already holds focus.
    //
    // …unless the mode says this stop is parked ([P12]). This branch is exactly
    // the filter-field and HUD class, and it is deliberately symmetric with the
    // watchdog's legality predicate (`isBareNativeControl` behind
    // `legalKeyboardElement`), so the two move as a pair: grant and legality
    // diverging would let the watchdog bless a caret the mode forbids — or
    // report the park as a violation and heal it away.
    const kvEl = this.keyViewElement();
    if (
      kvEl !== null &&
      this.coord.isBareNativeControl(kvEl) &&
      !this.parksTextStop()
    ) {
      const granted = this.grantTextSurface();
      this.coord.settleResponderForKeyView();
      // The route did not flip (this class grants under `engine-routed`), so
      // no `setRoute` repaint fires — but the paint reads the live grant
      // (`hasLiveNativeGrant`), and the grant just changed its answer.
      this.reproject();
      return granted;
    }
    // Accessibility mode ([P10]): real DOM focus mirrors the engine-routed
    // key view so assistive tech tracks it natively; the sink is never
    // focused while a key view exists. Falls through to the park when
    // there is no key-view element to mirror.
    if (
      this.coord.keyboardAccessMode() === "accessibility" &&
      this.coord.mirrorKeyViewFocus()
    ) {
      this.coord.settleResponderForKeyView();
      return true;
    }
    const parked = this.coord.parkKeySink();
    // The park moves no useful focusin, so the chain register tracks the
    // key view explicitly (see settleResponderForKeyView).
    this.coord.settleResponderForKeyView();
    // A park that retired a live NATIVE grant flipped no route (that class
    // grants under `engine-routed`), so repaint here — the paint's
    // `hasLiveNativeGrant` answer just changed under an unchanged key view.
    this.reproject();
    return parked;
  }

  /**
   * The GRANT half of a dom-granted placement ([P06]): move DOM focus to the
   * current key-view text surface. Honors the responder focus contract first,
   * with the generic DOM walk as fallback. Called only when the route is
   * dom-granted — engine-routed realization never touches DOM focus except
   * to park the sink.
   */
  private grantTextSurface(): boolean {
    if (this.keyViewId === null || typeof document === "undefined") return false;
    const id = this.keyViewId;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id;
    // Idempotency before the contract call: when the surface ALREADY holds
    // DOM focus (a focusin-driven placement legalizing the surface's own
    // claim), re-invoking the substrate's `focus()` would disturb the state
    // the surface just established (CM6's focus path normalizes the caret,
    // clobbering a freshly-restored selection). The placement's word is
    // already true; only the chain register needs settling.
    const hostEl = document.querySelector<HTMLElement>(
      `[data-responder-id="${escaped}"], [data-tug-focusable="${escaped}"]`,
    );
    const active = document.activeElement;
    if (
      hostEl !== null &&
      active instanceof HTMLElement &&
      (hostEl === active || hostEl.contains(active))
    ) {
      this.coord.settleResponderRegister(id);
      return true;
    }
    // Honor the responder focus contract first ([D03] #focus-contract): a
    // substrate that owns a non-trivial focus surface (the prompt editor's
    // CodeMirror `view.focus()`) declares how it takes focus, and the engine
    // must NOT re-implement that with a generic DOM walk — the walk lands on a
    // child input/button or nothing, never on a contenteditable caret. When the
    // key view is a registered responder, route through it so restoring the
    // editor key view lands the caret by construction.
    if (this.coord.focusKeyViewViaContract(id)) return true;
    // Generic fallback: focus the element itself when it is intrinsically
    // focusable or carries a non-negative tabindex, else its first tabbable
    // descendant.
    const el = document.querySelector<HTMLElement>(
      `[data-responder-id="${escaped}"], [data-tug-focusable="${escaped}"]`,
    );
    if (!el) return false;
    const tabIndexAttr = el.getAttribute("tabindex");
    const intrinsicallyFocusable =
      el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLAnchorElement;
    const hasFocusableTabIndex = tabIndexAttr !== null && parseInt(tabIndexAttr, 10) >= 0;
    // `preventScroll` on every engine focus write: scroll-position writes
    // belong to SmartScroll / the owning surface ([D07]) — a focus write must
    // never let the browser auto-scroll an off-viewport target into view.
    // Idempotency on both branches: a redundant re-`focus()` during a mount
    // commit can drop focus to body in WebKit — when the resolved element
    // already holds focus, the placement is already true.
    if (intrinsicallyFocusable || hasFocusableTabIndex) {
      if (document.activeElement !== el) el.focus({ preventScroll: true });
      return true;
    }
    const tabbable = el.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (tabbable) {
      if (document.activeElement !== tabbable) {
        tabbable.focus({ preventScroll: true });
      }
      return true;
    }
    return false;
  }

  /**
   * Re-run the current target's realization — the watchdog's re-grant lever
   * for a dom-granted route whose granted surface lost DOM focus to a raw
   * write. Same commit path as a placement (idempotent when already true);
   * preserves the current ring modality.
   */
  regrantCurrentTarget(): PlaceResult {
    return this.realizeTarget(
      this.currentTarget,
      this.keyViewKeyboard ? "keyboard" : "pointer",
      // Preserve the arrival: a watchdog re-grant is a repair of the placement
      // that already happened, not a new one. Letting it fall back to the
      // `"placement"` default would silently un-park a stop the engine moved
      // to ([P12]).
      { preventScroll: true, arrival: this.currentArrival },
    );
  }

  /**
   * The watchdog's incoherence fallback (Spec S03): the granted surface is
   * gone. Fall the route back to engine-routed so the keyboard keeps
   * working on the enclosing engine target instead of going dead.
   */
  noteGrantLost(): void {
    this.setRoute("engine-routed");
  }

  // ---- Focus target (record + realize) ----

  /**
   * The card's recorded focus destination — the one value placement writes
   * and activation projects. Written only by {@link FocusManager.place};
   * read at activation/restore to realize the card's destination.
   */
  private currentTarget: FocusTarget = { kind: "none" };

  // A recorded keyboard `focus-key` target whose focusable was not mounted
  // at placement time. `registerFocusable` re-runs the placement when a
  // matching, rendered record appears — the declarative late-mount rule
  // that replaced the imperative pending-restore set. Armed for KEYBOARD
  // placements only: a deferred pointer restore never yanks DOM focus onto
  // a stop that mounts later.
  private pendingRealizeKey: string | null = null;

  // The keyboard route of the current target — the derived cache
  // {@link keyboardRoute} reads. Recomputed inside {@link realizeTarget}
  // at every successful commit; a failed realization leaves it standing
  // (the previous target's route keeps routing keys). Starts
  // `engine-routed`: with no target placed, keys belong to the engine.
  private route: KeyboardRoute = "engine-routed";

  /** The card's recorded focus target. */
  target(): FocusTarget {
    return this.currentTarget;
  }

  /** The keyboard route of this context's current target (Spec S02). */
  keyboardRoute(): KeyboardRoute {
    return this.route;
  }

  /**
   * The one writer of {@link route}. The KBF paint keys on the route (a
   * granted caret stands `data-kbf` and the rings down; a park brings them
   * back), so a route flip is a repaint trigger in its own right — including
   * the flips no placement covers: a grant landing on the SAME key view
   * (`setKeyView`'s unchanged-pair early return skips its reproject) and the
   * watchdog's grant-lost fallback. `reproject` is active-gated and
   * diff-then-write, so a background context's flip and an unchanged answer
   * both cost nothing.
   */
  private setRoute(next: KeyboardRoute): void {
    if (this.route === next) return;
    this.route = next;
    this.reproject();
  }

  /**
   * Whether the current key view is a bare native text control HOLDING real
   * DOM focus — the granted-but-engine-routed class. The route deliberately
   * stays `engine-routed` for these (`focusKeyView`'s native branch; dispatch
   * and the watchdog's legality predicate are built on that symmetry), but
   * the caret is as live as any contract grant's, so the mode's paint
   * ({@link FocusManager.kbfPainting}) reads this alongside the route.
   */
  hasLiveNativeGrant(): boolean {
    if (typeof document === "undefined") return false;
    const el = this.keyViewElement();
    return (
      el !== null &&
      this.coord.isBareNativeControl(el) &&
      document.activeElement === el
    );
  }

  /**
   * How the keyboard arrived at the current target ([P12], Spec S05). Recorded
   * with the placement; `"placement"` until a movement performer says
   * otherwise. A grant (Return-descend, a printable character, a click) flips
   * it back, which is what retires the parked state without a second flag.
   */
  private currentArrival: FocusArrival = "placement";

  /** See {@link currentArrival}. */
  arrival(): FocusArrival {
    return this.currentArrival;
  }

  /**
   * Land the keyboard after the engine MOVED the key view — the one door the
   * movement performers use instead of a bare `focusKeyView()`, so the arrival
   * kind is recorded rather than inferred ([P12], Spec S05). A text stop
   * reached this way parks.
   */
  private landAfterMovement(): boolean {
    this.currentArrival = "movement";
    return this.focusKeyView();
  }

  /**
   * Park the current key view as a MOVEMENT arrival — ringed, caret gone. The
   * public door for an engagement gesture that must land visibly on a stop the
   * keyboard is already at: ⌥⇥ over a live caret sets the manual bit, and
   * without this the route stays granted, the paint stands down, and the
   * gesture reads as a dead key ([P09] promises "return to the ring", which
   * requires a ring). The park also moves the route to `engine-routed`, which
   * is what lets the second ⌥⇥ read as a toggle-off.
   */
  parkAtKeyView(): boolean {
    return this.landAfterMovement();
  }

  /**
   * Grant the caret at a parked text stop and re-land the keyboard — the
   * transition Return-descend and the printable-character branch both run
   * ([P12], #printable-grant).
   *
   * Flipping the arrival to `"placement"` IS the un-parking: the park predicate
   * reads the arrival, so there is no second "descended" flag to keep in step.
   * Re-realizing (rather than reprojecting) is what re-derives the route and
   * moves DOM focus onto the surface; `grantTextSurface`'s idempotency guard
   * puts the caret back where it was ([L23], [R01]).
   */
  grantParkedTextStop(): boolean {
    if (!this.hasParkedTextStop()) return false;
    this.currentArrival = "placement";
    return this.focusKeyView();
  }

  /**
   * Whether the key view is a text stop currently PARKED — ringed, no caret.
   * The gate on both grant transitions (Return, and a printable character).
   *
   * Reads the STATE, not its history. `parksTextStop` answers "should arriving
   * here park?" and is a question about the placement; this answers "is the
   * keyboard parked at a text stop right now?", which is what a keystroke is
   * responding to. Asking the arrival question here made the grant depend on a
   * value any later re-realization could reset, so a parked stop stayed parked
   * and typing did nothing — the ring said one thing and the predicate another.
   */
  hasParkedTextStop(): boolean {
    if (this.keyViewId === null) return false;
    // Engine-routed at a text stop, with the mode on, IS the parked state.
    if (this.route !== "engine-routed") return false;
    if (!this.coord.kbfEngaged()) return false;
    if (this.coord.responderHasFocusContract(this.keyViewId)) return true;
    const el = this.keyViewElement();
    return el !== null && this.coord.isBareNativeControl(el);
  }

  /**
   * Whether a text stop reached this way is **parked** — ringed, no caret —
   * rather than granted (Spec S05, [P12]).
   *
   * ```
   * parksTextStop =
   *      kbfEngaged()                      // rings exist at all
   *   && accessMode !== "accessibility"    // Class C carve-out
   *   && arrival === "movement"            // seeds and placements grant
   * ```
   *
   * The two carve-outs preserve the two properties the old
   * "a text surface never wears a ring" axiom was protecting that are still
   * true. **Accessibility mode never parks**: an engine-routed key view there
   * mirrors real DOM focus onto the key-view element, so parking a text stop
   * would put focus on the field's *wrapper* and strand an assistive-tech user
   * with no caret in any field until they typed. **A seeded or explicitly
   * placed stop never parks**: `rename-session-sheet` says so in its own
   * comment ("the engine seeds the key view onto the FIELD (caret on open)"),
   * and so do the gallery sheet, the resume sheet, the attachment preview, and
   * the session question / permission dialogs — every one a Class-A
   * auto-engaging surface, so an unqualified rule would open every text-first
   * sheet in the app ringed and unable to type.
   *
   * The caller supplies whether the target is a text contract, because the
   * three route sites each know that differently (a contract-bearing responder,
   * or a bare native control).
   */
  parksTextStop(): boolean {
    return (
      this.coord.kbfEngaged() &&
      this.coord.keyboardAccessMode() !== "accessibility" &&
      this.currentArrival === "movement"
    );
  }

  /**
   * Classify a target's keyboard route (Spec S02) — derived from the target
   * kind, the responder registry's focus-contract declaration, and (since KBF)
   * whether a text stop reached by MOVEMENT should park ([P12]).
   *
   * Still never a per-call flag: the mode is a derivation over engine state and
   * the arrival kind is recorded with the placement. Both are state, not caller
   * opinion, so there is still no way to author a contradiction.
   */
  private classifyRoute(target: FocusTarget): KeyboardRoute {
    const base = ((): KeyboardRoute => {
      switch (target.kind) {
        case "engine":
        case "state-key":
          return "dom-granted";
        case "responder":
          return this.coord.responderHasFocusContract(target.responderId)
            ? "dom-granted"
            : "engine-routed";
        case "focusable":
        case "focus-key":
        case "none":
          return "engine-routed";
      }
    })();
    // A text stop the engine MOVED to is parked: the ring lands, the caret does
    // not ([P12]). Everything else keeps the classification it always had.
    if (base === "dom-granted" && this.parksTextStop()) return "engine-routed";
    return base;
  }

  /** Record the card's focus target (bookkeeping half of a placement). */
  recordTarget(target: FocusTarget): void {
    this.currentTarget = target;
    if (
      target.kind !== "focus-key" ||
      this.pendingRealizeKey !== target.focusKey
    ) {
      this.pendingRealizeKey = null;
    }
  }

  /**
   * Realize a focus target against this context: set the key view and land
   * DOM focus in one atomic pass — the engine core {@link FocusManager.place}
   * drives. Callers never split this into a paint half and a focus half;
   * that split is exactly the drift the engine forbids.
   *
   * Safe against a background (non-key-card) context for the registry
   * kinds: `setKeyView`'s projection and `focusKeyView`'s focus move are
   * both active-gated, so a background realization updates the context's
   * key-view CACHE only — which is exactly what a background card's dialog
   * seed needs for its [P20] activation restore. The `engine` kind is the
   * one with un-gated side effects, so `place` never realizes it for a
   * background context.
   *
   * TRANSACTIONAL ([P06]): every kind resolves its target to a live,
   * registered/rendered destination FIRST; only on success does it commit
   * (key view + ring projection + route + focus move, one pass). A failed
   * resolution returns `"unrealized"` with NO state change beyond
   * `pendingRealizeKey` arming for keyboard `focus-key` placements — no
   * paint, no route flip, the previous target stands. A ring is never lit
   * over a destination that is not there.
   */
  realizeTarget(
    target: FocusTarget,
    modality: FocusModality,
    opts?: { preventScroll?: boolean; arrival?: FocusArrival },
  ): PlaceResult {
    // Record how we got here BEFORE any route is classified: `classifyRoute`
    // and `focusKeyView` both read it ([P12], Spec S05). An explicit placement
    // is the default, so only a movement performer can park a text stop.
    this.currentArrival = opts?.arrival ?? "placement";
    if (opts?.preventScroll === true) {
      this.revealSuppressed = true;
      try {
        return this.realizeResolvedTarget(target, modality, opts);
      } finally {
        this.revealSuppressed = false;
      }
    }
    return this.realizeResolvedTarget(target, modality, opts);
  }

  /**
   * `realizeTarget`'s body, split out so the `preventScroll` reveal
   * suppression above wraps every branch (and every `setKeyView` under them)
   * from one place.
   */
  private realizeResolvedTarget(
    target: FocusTarget,
    modality: FocusModality,
    opts?: { preventScroll?: boolean; arrival?: FocusArrival },
  ): PlaceResult {
    switch (target.kind) {
      case "none":
        this.setRoute(this.classifyRoute(target));
        // No destination: the keyboard is engine-owned at nothing — park
        // the sink (active context only) so `activeElement` is legal.
        if (this.isActive()) this.coord.parkKeySink();
        return "placed";
      case "focusable": {
        // Resolve: the id must name a registered, rendered focusable.
        // Placing an unregistered/unrendered id used to stamp the key-view
        // cache anyway — a ring promise over nothing (the paint-before-land
        // hole, by-id variant).
        const record = this.focusables.get(target.id);
        if (record === undefined || !this.isRecordRendered(record)) {
          return "unrealized";
        }
        this.setRoute(this.classifyRoute(target));
        this.setKeyView(target.id, modality === "keyboard");
        this.focusKeyView();
        return "placed";
      }
      case "focus-key": {
        // Rendered-only resolve: an unrendered record (a collapsed section's
        // stop) is "not mounted yet" for placement purposes.
        for (const record of this.focusables.values()) {
          if (record.group === "") continue;
          if (`${record.group}:${record.order}` !== target.focusKey) continue;
          if (!this.isRecordRendered(record)) continue;
          this.pendingRealizeKey = null;
          this.setRoute(this.classifyRoute(target));
          this.setKeyView(record.id, modality === "keyboard");
          this.focusKeyView();
          return "placed";
        }
        if (modality === "keyboard") {
          this.pendingRealizeKey = target.focusKey;
        }
        return "unrealized";
      }
      case "responder": {
        // Resolve: a registered responder node, or (in a DOM) a connected
        // element carrying the responder id. DOM-free with no chain is
        // permissive — the pure-logic suites drive responder placements
        // against bare managers, and there is no registry to contradict.
        if (!this.coord.responderTargetResolvable(target.responderId)) {
          return "unrealized";
        }
        // `focusKeyView` honors the responder focus contract first, so a
        // substrate (CM6 editor) lands its own caret.
        this.setRoute(this.classifyRoute(target));
        this.setKeyView(target.responderId, modality === "keyboard");
        this.focusKeyView();
        return "placed";
      }
      case "state-key": {
        // A keyed form control resolves by DOM attribute, not the focusable
        // registry. Focus it directly; the settled-focus derivation records
        // the key view from the resulting `focusin` — no paint half here.
        if (typeof document === "undefined") return "unrealized";
        const scope =
          this.cardId !== null
            ? document.querySelector(
                `[data-card-id="${cssEscapeId(this.cardId)}"]`,
              )
            : document;
        const el = scope?.querySelector<HTMLElement>(
          `[data-tug-state-key="${cssEscapeId(target.key)}"]`,
        );
        if (el === undefined || el === null || !el.isConnected) {
          return "unrealized";
        }
        // Idempotency: a redundant mount-time re-`focus()` can drop focus
        // to body in WebKit; when the control already holds focus, the
        // placement's word is already true.
        this.setRoute(this.classifyRoute(target));
        if (el.ownerDocument.activeElement !== el) {
          el.focus(
            opts?.preventScroll === true ? { preventScroll: true } : undefined,
          );
        }
        return "placed";
      }
      case "engine": {
        // The card's engine-owned text surface: focus lands through the
        // registered engine hook ([P21] content half). The hook's own
        // `view.focus()` fires `focusin`, and the derivation records the
        // editor as the key view with the placement's modality (pointer —
        // the caret is the focus mark; engine restores never ring).
        if (this.cardId === null) return "unrealized";
        const store = getDeckStore();
        if (store === null || !store.hasEngineHooks(this.cardId)) {
          return "unrealized";
        }
        // The D11 yield, engine edition: when the card ALREADY holds live DOM
        // focus — a caret in its find bar's query field, not the parked key
        // sink — the claim's word is already true, and invoking the hook
        // would yank that caret to the card's PRIMARY editor. The framework
        // branch has carried this yield since the dispatcher unified; the
        // engine branch went without only because a transient in-card editor
        // used to shadow the primary hook by accident.
        if (typeof document !== "undefined") {
          const root = document.querySelector(
            `[data-card-id="${cssEscapeId(this.cardId)}"]`,
          );
          const active = document.activeElement;
          if (
            root !== null &&
            active !== null &&
            active !== document.body &&
            root.contains(active) &&
            !(
              active instanceof HTMLElement &&
              active.closest(`[${KEY_SINK_ATTRIBUTE}]`) !== null
            )
          ) {
            this.setRoute(this.classifyRoute(target));
            return "placed";
          }
        }
        this.setRoute(this.classifyRoute(target));
        store.invokeEnginePaintMirrorAsActive(this.cardId);
        return "placed";
      }
    }
  }

  // ---- Focus-mode stack ----

  /**
   * Push a focus mode. The pushed mode becomes current; the Tab walk services
   * only its focusables. Captures the current key view so it can be restored on
   * pop ([#cfrunloop-model]). Pushing a `scopeId` already on the stack moves it
   * to the top (re-capturing the key view at that point).
   */
  pushFocusMode(
    scopeId: string,
    opts: {
      trapped: boolean;
      commitDisposition?: (commit: FocusCommit) => CycleDisposition;
      escapeExits?: boolean;
      onEscapeDismiss?: () => void;
      spaceDismisses?: boolean;
      /** Opt a trapped mode out of KBF auto-engagement ([P03]); default engage. */
      kbf?: boolean;
    },
  ): void {
    const existing = this.modeStack.findIndex((m) => m.scopeId === scopeId);
    if (existing !== -1) {
      this.modeStack.splice(existing, 1);
    }
    this.modeStack.push({
      scopeId,
      trapped: opts.trapped,
      restoreKeyView: this.keyViewId,
      restoreKeyViewKeyboard: this.keyViewKeyboard,
      commitDisposition: opts.commitDisposition,
      escapeExits: opts.escapeExits,
      onEscapeDismiss: opts.onEscapeDismiss,
      spaceDismisses: opts.spaceDismisses,
      // Capture the first responder alongside the key view ([#cfrunloop-model]):
      // a surface about to claim first responder on open (a modal confirm popover)
      // captures here, BEFORE its claim, so the pop restores the prior responder.
      restoreFirstResponder: this.coord.firstResponder(),
      kbf: opts.kbf,
    });
    this.reproject();
    this.notify();
    // A trapped push is Class-A auto-engagement (Spec S01): the mode may have
    // just turned on, which changes both the marks and the keyboard route.
    this.coord.settleKbfEngagement();
  }

  /**
   * Apply the current (top) mode's commit disposition after a keyboard
   * value-commit at the key view ([P15]). If the top mode declares
   * `commitDisposition` and it returns `relinquish` for this commit, pop that
   * mode. Returns whether the mode was relinquished.
   */
  applyCommitDisposition(kind: FocusCommitKind): boolean {
    const top = this.modeStack[this.modeStack.length - 1];
    if (!top || top.commitDisposition === undefined) return false;
    const disposition = top.commitDisposition({ kind, keyViewId: this.keyViewId });
    if (disposition !== "relinquish") return false;
    this.popFocusMode(top.scopeId);
    return true;
  }

  /**
   * Pop the named focus mode off the stack and restore the key view that was
   * current when it was pushed. No-op if it is not present.
   *
   * Restore fires only when popping the **top** mode (the common dismiss case);
   * popping a buried mode leaves the key view alone, since a mode still above
   * it owns the current scope.
   *
   * The restore has two independent axes, each gated by its own option (both
   * default `true`):
   * - `moveDomFocus` — move DOM focus onto the restored key view (the
   *   `focusKeyView` call). The key-view STATE (id + ring) is restored regardless;
   *   this gates only the `el.focus()`. A surface whose own teardown writer owns
   *   the DOM move (a Radix-trapped popover/sheet) pops `moveDomFocus: false`.
   * - `restoreFirstResponder` — reinstate the chain's first responder captured at
   *   push. A caller that owns the next focus itself (the cycle's pointer-exit —
   *   the click promotes its own responder) pops this `false`.
   */
  popFocusMode(
    scopeId: string,
    opts?: { moveDomFocus?: boolean; restoreFirstResponder?: boolean },
  ): void {
    const moveDomFocus = opts?.moveDomFocus ?? true;
    const restoreFirstResponder = opts?.restoreFirstResponder ?? true;
    const at = this.modeStack.findIndex((m) => m.scopeId === scopeId);
    if (at === -1) return;
    const wasTop = at === this.modeStack.length - 1;
    const [entry] = this.modeStack.splice(at, 1);
    this.reproject();
    if (wasTop) {
      // Restore the prior key view AND its keyboard-ness, so a key view that
      // wore the ring before this mode was pushed (e.g. a focus-cycling stop
      // that opened a popover by keyboard) gets the ring back on pop, while a
      // mouse-opened one restores ringless.
      this.setKeyView(entry.restoreKeyView, entry.restoreKeyViewKeyboard);
      // Restore the FIRST RESPONDER captured at push — the second axis of the
      // restore, alongside the key view. A trapped surface (a modal confirm popover)
      // may have claimed first responder on open so its own Cmd-. cancel landed; on
      // close, action dispatch must return to the responder the user was on, or a
      // first-responder-routed accelerator (Cmd-.) keeps landing on the now-closed
      // surface's stale handler. This is what makes "leave the responder as-is" close
      // paths (the engine-owns restore for a focus-refusing key view) correct by
      // construction. Gated on `restoreFirstResponder`: when it is false the caller
      // owns the next focus (the cycle's pointer-exit — the click promotes its own
      // responder), so the engine must not reinstate the prior one. A chain-head
      // change fires no focus event, so it cannot disturb the key view restored
      // above; a responder key view re-promotes itself through `focusKeyView` below.
      if (restoreFirstResponder && entry.restoreFirstResponder !== null) {
        this.coord.restoreFirstResponder(entry.restoreFirstResponder);
      }
      // Re-project the restored key view onto the DOM (move focus to it) when the
      // restored view wore the keyboard ring (a focus-cycle / Tab stop the surface
      // was opened from) — the engine owns its close-focus. A ringless view leaves
      // DOM focus to the responder-chain / Radix restore, so unrelated surfaces are
      // unaffected. A surface that displaces DOM focus on open and must re-project a
      // ringless key view now does so through its own teardown writer (the
      // `useFocusTrap` `onCloseAutoFocus`), not here — so it pops `moveDomFocus:
      // false` and this branch stays out of its way. Suppressed entirely when
      // `moveDomFocus` is false; `focusKeyView` is gated on active, so a background
      // pop never moves focus.
      if (
        moveDomFocus &&
        entry.restoreKeyView !== null &&
        entry.restoreKeyViewKeyboard
      ) {
        this.focusKeyView();
      }
    }
    // Always notify: popping a mode changes `isFocusModePushed` /
    // `currentFocusMode`, which subscribers observe (e.g. a card's `cycling`
    // flag) independently of the key view.
    this.notify();
    // Leaving an ENGAGING TRAP **all the way back to rest** leaves the mode: the
    // surface auto-engaged it, so the surface closing is the exit. Class A is
    // derived and needs nothing here, but the MANUAL bit is stored — ⌥⇥ inside
    // the surface writes it, and so does the mode the user turned on before the
    // gesture that opened it — so without this clear the bit outlives the
    // surface and leaves a ring on the deck the user just came back to. Cleared
    // rather than remembered: the derivation then answers from what is still
    // true, so a `kbfAtRest` card underneath keeps the mode on its own
    // authority.
    //
    // Two guards, and the second one is the one that is easy to miss:
    //
    //  - `trapped && kbf !== false` — the two opt-outs manage their own bit (a
    //    focus cycle IS the manual bit; the completion popup opens and closes
    //    mid-typing and must not touch it), and a non-trapped descend scope is a
    //    move within the mode, not out of it.
    //  - **the stack is now empty.** A popover opened FROM a cycle stop pops
    //    back into the cycle, and the cycle's engagement is carried by this very
    //    bit — clearing it there would close the cycle the user is still in, and
    //    the second Escape they expect to exit with would have nothing to exit.
    //    The rule is about returning to REST, not about any pop.
    if (entry.trapped && entry.kbf !== false && this.modeStack.length === 0) {
      this.coord.setKbfManual(false);
    }
    // Popping the last engaging trap disengages the mode (Spec S01) — derived,
    // so the surface closing IS the disengagement, with nothing to unlatch.
    this.coord.settleKbfEngagement();
  }

  /**
   * Pop a trapped sub-surface mode with a **relinquish** disposition toward its
   * enclosing focus cycle ([P15], generalized from a commit AT a cycle stop to a
   * commit in a sub-surface opened FROM a stop — a settings picker sheet).
   *
   * Instead of restoring the stop the surface was opened from (the ordinary
   * {@link popFocusMode} "return to opener" semantic — the *retain* disposition),
   * this cascade-pops the surface **and** the nearest enclosing cycle (a mode that
   * declares a `commitDisposition`, set only by `useCycleMode`) in ONE
   * engine-owned transition, landing on the cycle's own restore target. There is
   * no second writer: the surface's own close-focus restore is intentionally
   * skipped (the caller suppresses it), so nothing races the relinquish. The
   * cycle's consumer lands the resting caret off its `cycling` flag flipping false
   * (its `restingFocus`).
   *
   * Falls back to an ordinary pop when the surface is not inside a cycle (a
   * relinquish-disposition surface opened standalone just closes normally).
   */
  relinquishFocusMode(scopeId: string): void {
    const at = this.modeStack.findIndex((m) => m.scopeId === scopeId);
    if (at === -1) return;
    // The nearest enclosing relinquishable host: a cycle declares a
    // `commitDisposition` (only `useCycleMode` does), which marks it as a mode a
    // committed sub-surface can relinquish back to.
    let hostAt = -1;
    for (let i = at - 1; i >= 0; i -= 1) {
      if (this.modeStack[i].commitDisposition !== undefined) {
        hostAt = i;
        break;
      }
    }
    if (hostAt === -1) {
      // No enclosing cycle — there is nothing to relinquish; close normally.
      this.popFocusMode(scopeId);
      return;
    }
    const host = this.modeStack[hostAt];
    // One transition: drop the host cycle AND everything above it (this surface,
    // plus any modes between) in a single splice.
    this.modeStack.splice(hostAt);
    this.reproject();
    // Land on the cycle's restore target. The resting caret is typically a
    // responder (not a key view), so this clears the key view and the cycle
    // consumer's `restingFocus` reclaim (fired off `cycling` → false) lands the
    // caret; if the cycle's prior WAS a keyboard key view, restore it with its
    // ring.
    this.setKeyView(host.restoreKeyView, host.restoreKeyViewKeyboard);
    // Restore the first responder the cycle captured at entry (the resting caret's
    // responder, typically the editor) — the same second-axis restore popFocusMode
    // does, so a sub-surface committed from a cycle stop lands action dispatch back
    // on the cycle's resting responder. A chain-head change fires no focus event,
    // so the key view restored above stands. Complements the cycle consumer's
    // `restingFocus` reclaim.
    if (host.restoreFirstResponder !== null) {
      this.coord.restoreFirstResponder(host.restoreFirstResponder);
    }
    if (host.restoreKeyView !== null && host.restoreKeyViewKeyboard) {
      this.focusKeyView();
    }
    this.notify();
    this.coord.settleKbfEngagement();
  }

  /**
   * Move the key view to the first focusable in the current mode (authored
   * order) and return its id, or `null` if the mode has no focusables. The
   * engine's "set initial focus when a surface opens" primitive. Does not move
   * DOM focus; pair with `focusKeyView` for that.
   */
  focusFirstInMode(): string | null {
    const order = this.walkOrder();
    if (order.length === 0) return null;
    const id = order[0].id;
    this.setKeyView(id, true);
    return id;
  }

  /**
   * Land the keyboard for a mode just entered, WITHOUT advancing through it:
   * keep the ring on the current key view when that stop is also a stop in the
   * entered mode, and seed the mode's first stop only when it is not.
   *
   * Entering a mode is not a movement through it. ⌥⇥ with the caret in the
   * composer used to seed the commit-home ([P10]) unconditionally, so engaging
   * the mode moved the user's place before they had asked to go anywhere — and
   * the ring, whose whole job is to mark where the keyboard IS, appeared
   * somewhere the keyboard had not been. Whether the ring then had to travel
   * the entire cycle to get back is a matter of stop ordering, which is not
   * something mode entry should depend on.
   *
   * The landing is nonetheless a MOVEMENT arrival ([P12]), so a text stop
   * entered this way PARKS — ringed, caret gone. That is the point rather than
   * a side effect: it is what makes the ring visible on an editor at all (a
   * live caret is mode OFF and paints nothing), and it is what keeps ⌥⇥ a
   * toggle, since [P09] has the gesture re-engage rather than disengage while
   * the route is still `dom-granted`. Parking the stop moves the route to
   * `engine-routed`, so the second ⌥⇥ turns the mode off and the caret comes
   * back where it was.
   *
   * Returns the landed stop's id, or `null` when the mode has no stops.
   */
  enterModeAtKeyView(): string | null {
    const current = this.keyViewId;
    const retained =
      current !== null && this.walkOrder().some((f) => f.id === current);
    const id = retained ? current : this.focusFirstInMode();
    if (id === null) return null;
    if (retained) this.setKeyView(id, true);
    this.landAfterMovement();
    return id;
  }

  /** The current (top) focus mode id, or `BASE_FOCUS_MODE` when none pushed. */
  currentFocusMode(): string {
    const top = this.modeStack[this.modeStack.length - 1];
    return top ? top.scopeId : BASE_FOCUS_MODE;
  }

  /**
   * Whether `scopeId` is anywhere on this context's mode stack — current OR
   * merely covered by a transient mode pushed on top of it (e.g. a popover
   * opened from within a focus-cycling card). A consumer that asks "am I still in
   * this mode?" (the cycling card) wants this, not top-of-stack.
   */
  isFocusModePushed(scopeId: string): boolean {
    return this.modeStack.some((m) => m.scopeId === scopeId);
  }

  /**
   * Class A of the KBF derivation (Spec S01): whether any **trapped** mode entry
   * on this context's stack auto-engages keyboard-focus mode.
   *
   * `trapped` is load-bearing. `pushFocusMode` also carries non-trapped descend
   * scopes — a list-row scope, an accordion-section scope — which are pushed
   * *while already navigating* rather than because a surface appeared. Engaging
   * on those would make a descend an engagement event and let a mode-OFF card
   * enter KBF by descending into one of its own lists.
   *
   * An entry opts out with `kbf: false` ([P03]) — the escape hatch for a
   * typing-first surface that traps the keyboard but must keep text ownership.
   */
  hasEngagingTrap(): boolean {
    return this.modeStack.some((m) => m.trapped && m.kbf !== false);
  }

  /**
   * Pop the current mode when it is a **focus cycle** — the pointer-exit half
   * of [P05]. A cycle is the trapped mode that opts into `escapeExits`: it has
   * no surface of its own, so unlike a sheet or a menu it is the engine's to
   * close. A sheet opened FROM a cycle stop is its own top mode and is left
   * alone, so its close can still return focus to the stop that opened it.
   *
   * Pops without moving DOM focus or restoring the first responder: the click
   * that triggered this owns the next focus. Returns whether a cycle popped.
   */
  popCycleModeForPointerExit(): boolean {
    const top = this.modeStack[this.modeStack.length - 1];
    if (!top || !top.trapped || top.escapeExits !== true) return false;
    this.popFocusMode(top.scopeId, {
      moveDomFocus: false,
      restoreFirstResponder: false,
    });
    return true;
  }

  /**
   * Whether the current (top) focus mode is trapped (modal). `false` at the base
   * mode. The act dispatch ascends only **non-trapped** scopes ([P02]).
   */
  currentFocusModeTrapped(): boolean {
    const top = this.modeStack[this.modeStack.length - 1];
    return top ? top.trapped : false;
  }

  /**
   * Whether the current (top) focus mode opted into Escape-exit (`escapeExits`) —
   * a focus-cycle that Escape pops back to rest, distinct from a modal surface that
   * owns its own Escape. `false` at the base mode. The act dispatch consults this to
   * route Escape on a trapped cycle to {@link escapeCurrentMode} instead of leaving
   * it to the surface's cancel ([R04]).
   */
  currentFocusModeEscapeExits(): boolean {
    const top = this.modeStack[this.modeStack.length - 1];
    return top ? top.escapeExits === true : false;
  }

  /**
   * The current (top) focus mode's registered dismiss callback, or `null` when
   * the base mode is current or the top mode registered none. The Escape ladder
   * calls this to ask "does the top surface own its own dismissal?" — branch (2)
   * of [P02]. A returned callback is invoked once and the Escape consumed.
   */
  currentFocusModeOnEscapeDismiss(): (() => void) | null {
    const top = this.modeStack[this.modeStack.length - 1];
    return top?.onEscapeDismiss ?? null;
  }

  /**
   * Whether the current (top) focus mode opted into Space-dismiss
   * ({@link FocusModeEntry.spaceDismisses}) — an info popover that a second
   * Space closes. The act dispatch consults this (with its own
   * interactive-control gate) before treating a Space at the popover's chrome
   * as a dismiss. `false` at the base mode.
   */
  currentFocusModeSpaceDismisses(): boolean {
    const top = this.modeStack[this.modeStack.length - 1];
    return top ? top.spaceDismisses === true : false;
  }

  /**
   * Whether a pushed (non-base) scope owns this card's key destination: there is
   * a current trap / cycle / descend AND a key view to land on. The [P20] gate —
   * the coordinator consults it on (re)activation so a pending card-modal dialog
   * (or a mid-flow cycle) is re-established as the card's focus destination
   * instead of the resting editor.
   */
  hasPushedKeyDestination(): boolean {
    return this.currentFocusMode() !== BASE_FOCUS_MODE && this.keyViewId !== null;
  }

  // ---- Default-action resolution ----

  /**
   * Declare (or clear) the default action a scope's `Return` resolves to. The
   * scope is a focus-mode id (or `BASE_FOCUS_MODE`). Passing `null` clears it.
   */
  setDefaultAction(scopeId: string, action: TugAction | null): void {
    if (action === null) {
      this.defaultActions.delete(scopeId);
    } else {
      this.defaultActions.set(scopeId, action);
    }
    this.notify();
  }

  /**
   * Resolve the default action of the current focus mode, or `null` if the
   * current mode declares none.
   */
  resolveDefaultAction(): TugAction | null {
    return this.defaultActions.get(this.currentFocusMode()) ?? null;
  }

  // ---- Tab walk ----

  /**
   * Advance the key view to the next focusable in the current mode's authored
   * order, wrapping past the last to the first. Returns the new key-view id,
   * or `null` if the current mode has no participating focusables.
   */
  focusNext(): string | null {
    return this.advance(1);
  }

  /**
   * Advance the key view to the previous focusable in the current mode's
   * authored order, wrapping past the first to the last. See `focusNext`.
   */
  focusPrevious(): string | null {
    return this.advance(-1);
  }

  /**
   * The ordered list of focusables that participate in the current mode and
   * pass the current keyboard-access policy filter. Exposed for the Tab
   * pipeline and for inspection; the walk uses it directly.
   */
  walkOrder(): FocusableRecord[] {
    const accepted = this.walkModeSet();
    const accessMode = this.coord.keyboardAccessMode();
    const records: FocusableRecord[] = [];
    for (const record of this.focusables.values()) {
      const inMode = record.modes.some((m) => accepted.has(m));
      if (!inMode) continue;
      if (accessMode === "standard" && record.policy === "skip") continue;
      // A focusable in a hidden subtree is not a reachable Tab target. With
      // per-card contexts the walk already sees only THIS card's focusables, so
      // this filter is the *within-card* hidden-subtree guard (a collapsed
      // accordion section, a conditionally-hidden control) — not the retired
      // cross-card display:none exclusion. A no-op without a DOM (pure-logic walk
      // tests) and when the element can't be resolved.
      if (!this.isRecordRendered(record)) continue;
      // A disabled / pointer-inert control is not a reachable Tab target — the
      // walk skips it so, e.g., the prompt submit drops out of the cycle while
      // the editor is empty (its empty-input gate) and the seed lands on the
      // next live stop instead.
      if (!this.isRecordInteractive(record)) continue;
      records.push(record);
    }
    records.sort((a, b) => this.compareFocusables(a, b));
    return records;
  }

  /**
   * The set of mode ids the Tab walk services for the current mode stack
   * ([#cfrunloop-model]).
   *
   * Every PUSHED mode CONTAINS the walk to its own focusables, whatever its
   * `trapped` flag:
   *  - a modal trap (sheet / inline dialog) — Tab cycles the surface, Escape
   *    dismisses;
   *  - a card's focus-cycle — Tab cycles the card's stops;
   *  - a **descend** scope (an accordion section, a list row) — Tab is a LOCKED
   *    loop inside the descended content, and Escape ASCENDS one level.
   *
   * `trapped` governs only the Escape semantics (ascend vs dismiss), NOT the
   * breadth of the Tab walk — a non-trapped descend is still Tab-contained. A
   * descend must never widen the walk to the enclosing scope (it would break the
   * locked loop). (Per-card contexts already isolate each card's base mode, so
   * `BASE_FOCUS_MODE` no longer spans other cards.) Only the bare base mode
   * (nothing pushed) services the base focusables.
   */
  private walkModeSet(): Set<string> {
    const top = this.modeStack[this.modeStack.length - 1];
    return new Set<string>([top ? top.scopeId : BASE_FOCUS_MODE]);
  }

  /**
   * Whether `id` is a registered focusable participating in the current
   * mode — the same membership the Tab walk uses. A responder id that is not
   * a registered focusable (a card, a pane, a sheet container) is not a
   * member.
   */
  currentModeMember(id: string | null): boolean {
    if (id === null) return false;
    const record = this.focusables.get(id);
    if (record === undefined) return false;
    const accepted = this.walkModeSet();
    return record.modes.some((m) => accepted.has(m));
  }

  /**
   * Resolve a focusable record's live DOM element (the responder container or
   * the focusable element carrying its id), or `null` if absent / no document.
   */
  private resolveFocusableElement(record: FocusableRecord): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(record.id)
        : record.id;
    return document.querySelector<HTMLElement>(
      `[data-responder-id="${escaped}"], [data-tug-focusable="${escaped}"]`,
    );
  }

  /**
   * Whether a focusable's element is currently rendered (lays out a box). Used
   * by the walk to exclude focusables inside a hidden (`display: none`) subtree
   * **inside the active card** (a collapsed accordion section). Returns `true`
   * when there is no document or the element can't be resolved, so the in-memory
   * walk (tests / SSR) is never narrowed by a DOM that isn't there.
   */
  private isRecordRendered(record: FocusableRecord): boolean {
    if (typeof document === "undefined") return true;
    const el = this.resolveFocusableElement(record);
    if (el === null) return true;
    return el.getClientRects().length > 0;
  }

  /**
   * Whether a focusable's element is currently *interactive* — the walk must
   * never land the key view on a control that cannot be activated. Excludes
   * native-`disabled` and `aria-disabled` elements and elements made
   * pointer-inert by CSS (`pointer-events: none`). Reads the DOM at walk time;
   * permissive without a DOM (returns `true`) so the pure-logic walk tests are
   * never narrowed.
   */
  private isRecordInteractive(record: FocusableRecord): boolean {
    if (typeof document === "undefined") return true;
    const el = this.resolveFocusableElement(record);
    if (el === null) return true;
    if (el.matches(':disabled, [aria-disabled="true"]')) return false;
    if (
      typeof window !== "undefined" &&
      window.getComputedStyle(el).pointerEvents === "none"
    ) {
      return false;
    }
    return true;
  }

  private advance(step: 1 | -1): string | null {
    const order = this.walkOrder();
    if (order.length === 0) return null;
    const current =
      this.keyViewId === null
        ? -1
        : order.findIndex((r) => r.id === this.keyViewId);
    // When the key view is absent from the walk, a forward step starts at the
    // first element and a backward step at the last.
    const base = current === -1 ? (step === 1 ? -1 : 0) : current;
    const nextIndex = (base + step + order.length) % order.length;
    const nextId = order[nextIndex].id;
    this.setKeyView(nextId, true);
    return nextId;
  }

  // ---- Spatial arrow navigation ([P22] / [P23]) ----

  /**
   * Declare the spatial arrow order for a focus mode (the bounded scope a card or
   * dialog draws). Registration ([Q12]); read by {@link moveKeyViewSpatial} for the
   * current mode. No DOM projection, so no notify.
   */
  registerSpatialOrder(scopeId: string, order: SpatialOrder): void {
    this.spatialOrders.set(scopeId, order);
  }

  /** Drop a declared spatial order (on unmount of the layout that declared it). */
  unregisterSpatialOrder(scopeId: string): void {
    this.spatialOrders.delete(scopeId);
  }

  /** Register a group key view's live cursor handle (the delegation contract). */
  registerCursorHandle(id: string, handle: SpatialCursorHandle): void {
    this.cursorHandles.set(id, handle);
  }

  /** Drop a group's cursor handle (on unmount / when it stops being a group). */
  unregisterCursorHandle(id: string): void {
    this.cursorHandles.delete(id);
  }

  /**
   * Move the key view one step along the current mode's linear walk order — the
   * liveliness net under the spatial plane. `down` / `right` advance, `up` / `left`
   * retreat, both wrapping (the walk is modulo its length) and both mode-bounded, so
   * a walk inside a trap never escapes it. Returns the moved focusable id, or `null`
   * when the current mode has no participating focusables.
   *
   * Performs **no focus write**: it moves the key view and hands the id back, so the
   * caller realizes it (context-internal callers via `focusKeyView`, external callers
   * via `place`). That keeps this method from becoming a second focus writer ([L22]).
   */
  moveKeyViewLinear(direction: SpatialDirection): string | null {
    return direction === "down" || direction === "right"
      ? this.focusNext()
      : this.focusPrevious();
  }

  /**
   * Move the focus ring spatially in `direction` ([P22] / [P23]): delegate an
   * in-group arrow to the ringed group's cursor, cross a declared seam / ring at a
   * boundary, or descend on Right where disclosure is available. Returns `true` when
   * the navigator owns the arrow (moved the ring, drove a group cursor, descended,
   * or walked on from an undeclared edge), so the caller consumes it; `false` when
   * no declared order and no group claim this arrow — it is not the spatial plane's.
   *
   * Never beeps: a closed ring always yields a next node and a declared seam always
   * has a target; a group at an undeclared edge walks on along the linear order
   * rather than failing, and holds (still consuming) when there is nowhere to walk.
   * A non-group node with a declared order but no target for this arrow is a *dead
   * arrow* ([R06]) — warned at dev time, never a beep.
   */
  moveKeyViewSpatial(direction: SpatialDirection): boolean {
    const id = this.keyViewId;
    if (id === null) return false;
    const handle = this.cursorHandles.get(id);
    // Tree-disclosure descend on Right keeps its meaning wherever descent is
    // available ([P02]) — consulted before spatial movement.
    if (direction === "right" && (handle?.tryDescendRight() ?? false)) return true;
    const order = this.spatialOrderInScope();
    if (order === undefined && handle === undefined) return false;
    // The declared order references nodes by their stable `group:order` focus key
    // ([Q12]) — the same key the dialog seeds with — so an author never needs an
    // auto-generated focusable id. Map the ringed id to its key (fall back to the
    // raw id for an unkeyed node, e.g. the engine tests).
    const node = this.focusKeyOf(id) ?? id;
    // Inject the ringed group's LIVE cursor length so the resolver can detect its
    // edge; only the current node's group-ness matters to a single resolution.
    const effective: SpatialOrder = {
      rings: order?.rings ?? [],
      seams: order?.seams,
      overrides: order?.overrides,
      groups:
        handle !== undefined
          ? [{ node, length: handle.length(), columns: handle.columns?.() ?? 1 }]
          : order?.groups,
    };
    // A horizontal arrow against a vertical-axis group ([P12]) is not the cursor's:
    // withholding the index skips group delegation entirely, so the arrow resolves
    // against the seams / rings and then the net, instead of stepping the cursor.
    const horizontal = direction === "left" || direction === "right";
    const claimsArrow = !(horizontal && (handle?.axis ?? "both") === "vertical");
    const cursorIndex = handle !== undefined && claimsArrow ? handle.cursorIndex() : null;
    const resolution = resolveSpatial(effective, node, direction, cursorIndex);
    if (resolution.kind === "cursor") {
      handle?.moveCursor(resolution.delta);
      return true;
    }
    if (resolution.kind === "ring") {
      const targetId = this.idForFocusKey(resolution.target);
      const targetRecord = targetId !== null ? this.focusables.get(targetId) : undefined;
      if (
        targetId !== null &&
        targetRecord !== undefined &&
        this.isRecordRendered(targetRecord) &&
        this.isRecordInteractive(targetRecord)
      ) {
        this.setKeyView(targetId, true);
        this.landAfterMovement();
        return true;
      }
      // The declared target is absent or non-interactive (a disabled stop — e.g. a
      // toolbar chip on the Shell route). Don't strand the ring on a dead node: fall
      // through to the liveliness walk below, which skips disabled stops and lands on
      // the next interactive key view. So an author can declare a fixed grid over a
      // dynamic layout without recomputing membership per state.
    }
    // resolution.kind === "none" — no spatial target (a group edge, or an arrow the
    // declared rings / seams don't cover) — or a ring target that was non-interactive.
    if (order !== undefined && this.nodeInOrder(order, node)) {
      // A genuine dead arrow ([R06]): the node is ON the declared spatial plane but
      // this direction names no override / seam / ring target. The liveliness net
      // below still moves the ring (the model never beeps), so this is purely an
      // authoring signal — surface it once at dev time so the gap is visible and the
      // author can declare the edge. Scoped to a real `none` (a ring target that was
      // merely non-interactive is the endorsed dynamic-layout case, [#step-7-8], not
      // an authoring gap) and to a non-group node (a group legitimately returns `none`
      // at its cursor edge to fall through to a seam).
      if (resolution.kind === "none" && handle === undefined) {
        this.warnDeadArrow(node, direction);
      }
      // Liveliness ([P23] — "never beeps falls back to the design-time ordering"):
      // within a declared spatial scope, fall back to the linear groupOrder walk —
      // down / right advance, up / left retreat, both wrapping. Every arrow moves the
      // ring SOMEWHERE; the interface never beeps and never silently swallows the
      // key. (The authored rings / seams give the *spatial* feel; this is the net
      // under them so a layout can never trap the ring in a dead-end corner.)
      //
      // Gated on the ringed node actually being *part of* the declared order: a key
      // view the author left OUT of the order (a Tab-reached list that owns its own
      // arrows) is not on the spatial plane, so the navigator yields the arrow to that
      // surface's own handler rather than dragging it into the linear net.
      const moved = this.moveKeyViewLinear(direction);
      if (moved !== null) {
        this.landAfterMovement();
        return true;
      }
    }
    if (handle !== undefined) {
      // A group at an edge in a scope with NO declared order. The same liveliness net
      // applies here as inside a declared scope ([P01]): the arrow walks on along the
      // linear order instead of clamping, so a list's last row continues into whatever
      // is authored after it (the rail's next section) rather than dead-ending. When
      // the walk finds nowhere to go the group simply holds — either way the arrow is
      // consumed, so the page never scrolls and the key never beeps ([P08]).
      if (this.moveKeyViewLinear(direction) !== null) this.landAfterMovement();
      return true;
    }
    return false;
  }

  /**
   * The spatial order governing the current keyboard scope ([P22] / [P23]).
   *
   * Not simply the top mode's order: a DESCEND scope (`trapped: false` — a list
   * row, an accordion section) can sit ABOVE the scope that declared the plane,
   * and descending into a row inside a dialog does not hand that row the
   * dialog's arrows — it leaves them on the dialog's declared plane. So the walk
   * runs top-down for the first mode that declared an order, and STOPS at the
   * first trapped mode it passes (inclusive): a trap that declares nothing has
   * no plane, and the card's order below it is not the trap's to borrow.
   */
  private spatialOrderInScope(): SpatialOrder | undefined {
    for (let i = this.modeStack.length - 1; i >= 0; i -= 1) {
      const entry = this.modeStack[i];
      const order = this.spatialOrders.get(entry.scopeId);
      if (order !== undefined) return order;
      if (entry.trapped) return undefined;
    }
    return this.spatialOrders.get(BASE_FOCUS_MODE);
  }

  /**
   * Whether a node key is referenced anywhere in a declared order — as a ring
   * member, a seam / override endpoint, or a delegated group. A node the author did
   * not place in the order is off the spatial plane: the navigator yields its arrows
   * (it does not apply the liveliness fallback) so a Tab-reached surface keeps its
   * own keyboard.
   */
  private nodeInOrder(order: SpatialOrder, node: string): boolean {
    if (order.rings.some((ring) => ring.nodes.includes(node))) return true;
    if (order.seams?.some((seam) => seam.from === node || seam.to === node)) return true;
    if (order.overrides?.some((o) => o.from === node || o.to === node)) return true;
    if (order.groups?.some((group) => group.node === node)) return true;
    return false;
  }

  /**
   * Emit a one-time dev-time reachability warning for a dead arrow ([R06]): a node
   * declared in the current scope's spatial order whose arrow in `direction` resolves
   * to no override / seam / ring target. The navigator's liveliness net still moves
   * the ring (the model never beeps), so this is an authoring signal only — declare a
   * seam / override / ring edge for this (node, direction) to silence it. De-duped per
   * `mode|node|direction` so a repeated keypress reports once. No-op in production.
   */
  private warnDeadArrow(node: string, direction: SpatialDirection): void {
    if (process.env.NODE_ENV === "production") return;
    const mode = this.currentFocusMode();
    const dedupeKey = `${mode}|${node}|${direction}`;
    if (this.warnedDeadArrows.has(dedupeKey)) return;
    this.warnedDeadArrows.add(dedupeKey);
    tugDevLogStore.warn(
      "focus-spatial",
      `dead arrow: "${node}" declares no ${direction} target in spatial scope "${mode}" — fell back to linear movement; declare a seam, override, or ring edge`,
      { node, direction, scope: mode, cardId: this.cardId },
    );
  }

  /** A focusable's stable spatial node key (`group:order`), or `null` if ungrouped. */
  private focusKeyOf(id: string): string | null {
    const record = this.focusables.get(id);
    if (record === undefined || record.group === "") return null;
    return `${record.group}:${record.order}`;
  }

  /**
   * The id of the rendered focusable with this `group:order` key, or `null`. Prefers
   * a rendered record so the navigator lands the ring on a live target.
   */
  private idForFocusKey(focusKey: string): string | null {
    let fallback: string | null = null;
    for (const record of this.focusables.values()) {
      if (record.group === "" || `${record.group}:${record.order}` !== focusKey) continue;
      if (this.isRecordRendered(record)) return record.id;
      fallback ??= record.id;
    }
    return fallback;
  }

  /**
   * The focus ORDERS currently registered in `group`, ascending and deduped —
   * the group's live membership, addressed the way a spatial order addresses a
   * node ([Q12]: a stop is `group:order`).
   *
   * For a surface that DERIVES its spatial plane from what is registered rather
   * than from a hand-kept list (the rail). The alternative is an author
   * remembering to add each new control to a table somewhere else, and the
   * failure when they don't is silent — the stop is simply off the plane and the
   * liveliness net catches its arrows, which looks like nothing at all. Reading
   * the registry closes that class by construction.
   *
   * Duplicates collapse because two stops sharing a group and an order share a
   * focus key, which is already broken independently of any plane: the engine
   * resolves that key to one of them and the other is unaddressable.
   */
  focusOrdersInGroup(group: string): number[] {
    const orders = new Set<number>();
    for (const record of this.focusables.values()) {
      if (record.group === group) orders.add(record.order);
    }
    return [...orders].sort((a, b) => a - b);
  }

  private compareFocusables(a: FocusableRecord, b: FocusableRecord): number {
    const ga = this.groupIndex(a.group);
    const gb = this.groupIndex(b.group);
    if (ga !== gb) return ga - gb;
    if (a.order !== b.order) return a.order - b.order;
    return a.seq - b.seq;
  }

  private groupIndex(group: string): number {
    const i = this.groupOrder.indexOf(group);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }

  // ---- Default ring ----

  /**
   * Register a button as this card's persistent-default-ring node ([P14]). The
   * engine owns the `data-default-ring` attribute from here, projecting it in
   * lockstep with the key view. Innermost-wins: a nested surface's node takes
   * over while mounted and the prior node is restored on
   * {@link unregisterDefaultRing}.
   */
  registerDefaultRing(node: HTMLElement): void {
    if (this.defaultRingStack.includes(node)) return;
    this.defaultRingStack.push(node);
    this.reproject();
  }

  /** Remove a persistent-default-ring node (on unmount / opt-out). */
  unregisterDefaultRing(node: HTMLElement): void {
    const i = this.defaultRingStack.indexOf(node);
    if (i < 0) return;
    this.defaultRingStack.splice(i, 1);
    node.removeAttribute("data-default-ring");
    this.reproject();
  }

  // ---- DOM projection (key-card only) ----

  /**
   * Reproject this context's engine marks onto the DOM.
   *
   * Gated on active: a background context never projects, so this is a no-op
   * unless this context is the key card's. When it IS active, the coordinator
   * recomputes the whole projection from engine state and converges the DOM to
   * it — see {@link FocusManager.reproject}.
   */
  reproject(): void {
    if (!this.isActive()) return;
    this.coord.reproject();
  }

  /**
   * The mark half of the projection for THIS context — the part derived from
   * context state alone, with no deck globals and no DOM reads. Split out so
   * the derivation can be exercised without a document; the coordinator adds
   * the deck-global fields and resolves elements.
   */
  projectionState(): FocusProjectionState {
    const top = this.modeStack[this.modeStack.length - 1];
    // Only a DESCEND scope (`trapped: false` — an accordion section, a list
    // row) projects the within mark: there the key view moves INTO a container
    // that stays its DOM ancestor, so marking that container "contains the
    // active component" is true. A trapped floating surface (popover / sheet /
    // alert / menu) is portaled OUT of its trigger — the captured
    // `restoreKeyView` is the trigger, which does not contain the surface — so
    // projecting the within mark onto it paints a spurious ring on the host
    // control behind the open surface.
    // An element is never its own container: when a descend scope's captured
    // `restoreKeyView` IS the current key view (a row descend that lands the key
    // view back on the node it was pushed from — an inline dialog seeds its
    // default button, then the enclosing list descends into that row and places
    // on the same button), the within mark would paint on the key view itself.
    // `[data-key-within]` is authored after `[data-key-view-kbd]` at equal
    // specificity, so the faint within outline would WIN over the crisp role
    // ring on the live control.
    const withinCandidate =
      top === undefined || top.trapped ? null : (top.restoreKeyView ?? null);
    const keyWithinId =
      withinCandidate === this.keyViewId ? null : withinCandidate;
    const mode = this.currentFocusMode();
    return {
      keyViewId: this.keyViewId,
      keyViewKeyboard: this.keyViewKeyboard,
      keyWithinId,
      focusMode: mode === BASE_FOCUS_MODE ? null : mode,
      route: this.route,
    };
  }

  /** The top of this context's default-ring stack, or `null` at base. */
  defaultRingTop(): HTMLElement | null {
    return this.defaultRingStack[this.defaultRingStack.length - 1] ?? null;
  }

  /** Resolve the DOM element carrying the current key view, or `null`. */
  keyViewElement(): HTMLElement | null {
    if (typeof document === "undefined" || this.keyViewId === null) return null;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(this.keyViewId)
        : this.keyViewId;
    return document.querySelector<HTMLElement>(
      `[data-responder-id="${escaped}"], [data-tug-focusable="${escaped}"]`,
    );
  }

  /**
   * Whether the current key view is itself a button — the one control that
   * claims the scope's Return for its own activation.
   */
  keyViewIsButton(): boolean {
    const el = this.keyViewElement();
    if (el === null) return false;
    return el instanceof HTMLButtonElement || el.closest(".tug-button") !== null;
  }

  // ---- Internal ----

  private notify(): void {
    this.coord.notifyChange();
  }
}

// ---- FocusManager (deck coordinator) ----

export class FocusManager {
  // The per-card focus universes, keyed by cardId, plus the default context for
  // the no-card path (tests / gallery / standalone previews).
  private contexts: Map<string, FocusContext> = new Map();
  private readonly defaultContext: FocusContext;
  // The key card — activation-driven authority ([P21]). `null` = no card active,
  // so the default context is serviced. Set by `setKeyCard` / `adoptKeyCard`
  // from the activation-focus channel; projection is downstream of it.
  private keyCardId: string | null = null;

  // ---- Deck-global settings ----
  // When true, the focus ring also follows *pointer*-driven key-view changes.
  private ringFollowsPointer = false;
  private accessMode: KeyboardAccessMode = "standard";

  // ---- Subscription (single global notify-all) ----
  private version = 0;
  private subscribers: Set<() => void> = new Set();

  // ---- Chain attachment ----
  private chain: ResponderChainManager | null = null;

  constructor() {
    this.defaultContext = new FocusContext(this, null);
  }

  // ---- Context resolution / key card ----

  /**
   * Resolve the {@link FocusContext} for a card. A concrete `cardId` routes to
   * that card's context (created lazily) — even when it is a *background* card,
   * which is how a dialog mounting in a non-key card lands its trap in the right
   * universe. `null` (a card-less surface, or the gallery) routes to the **active
   * context**: chrome around the key card belongs to the key card, and with no
   * key card the active context is the default context. The hooks pass the
   * `CardIdContext` value here.
   */
  contextFor(cardId: string | null): FocusContext {
    if (cardId === null) return this.activeContext();
    let ctx = this.contexts.get(cardId);
    if (ctx === undefined) {
      ctx = new FocusContext(this, cardId);
      this.contexts.set(cardId, ctx);
    }
    return ctx;
  }

  /**
   * The context the coordinator services — the key card's, or the default
   * context when no key card is set. Every param-free public method below
   * delegates here (the document-listener path + the pure-logic tests).
   */
  activeContext(): FocusContext {
    if (this.keyCardId === null) return this.defaultContext;
    return this.contexts.get(this.keyCardId) ?? this.defaultContext;
  }

  /** Whether `ctx` is the active (key card's) context — the projection gate. */
  isActiveContext(ctx: FocusContext): boolean {
    return this.activeContext() === ctx;
  }

  /** The current key card id, or `null`. Activation-driven authority. */
  keyCard(): string | null {
    return this.keyCardId;
  }

  /**
   * Set the key card and project its context to the DOM ([P21] activation). The
   * reprojection derives every mark from the NEW active context's state, so it
   * reconciles away the just-deactivated context's marks in the same pass.
   * Idempotent for an unchanged key card (re-projects so a re-activation of the
   * same card — a window blur→focus — re-stamps its marks). Pass `null` to clear
   * the key card (back to the default context).
   */
  setKeyCard(cardId: string | null): void {
    const changed = this.keyCardId !== cardId;
    this.keyCardId = cardId;
    this.reproject();
    // Reconcile the first responder for the now-active card — the per-card FR
    // axis of activation. setKeyCard is the UNIVERSAL activation signal: the
    // provider's `syncKeyCard` fires it for every way a card becomes active
    // (click, tab switch, **pane activation / frontmost change**, cross-pane
    // move, pane cycle, cold boot). This is the synchronous edge of the [P21]
    // framework half. What happens AFTER the activation moment is settled by
    // the OTHER two owners, not by this call: a late content mount (an em
    // card's editor binding after activation) is claimed by the framework's
    // engine-hook retry (`applyBagFocus` re-run via `subscribeEngineHooks
    // change` — the [P21] content half), and an unregister cascade is repaired
    // by the chain's own unregister-promotes-ancestor path. FR promotion is
    // chain (structure) state, not a DOM focus claim, so it belongs here
    // beside naming the key card; the DOM focus claim stays in `adoptKeyCard`.
    if (cardId !== null) this.settleFirstResponderForActivation();
    if (changed) {
      this.touch();
      // The key card is a KBF derivation input (Class B, Spec S01): switching
      // to a `kbfAtRest` card engages the mode and away from one disengages it.
      this.settleKbfEngagement();
      // The manual bit is deck-global and survives a keyboard-driven card
      // switch ([P05]), so a ⌘L into a card that has never been focused would
      // otherwise arrive engaged with nothing ringed. Seed the new key card.
      if (this.kbfEngaged()) this.seedKbfRing();
    }
  }

  /**
   * Adopt `cardId` as the key card and, if its context already owns a pushed key
   * destination (a pending card-modal dialog's trap, a mid-flow cycle, a
   * descended scope), land DOM focus on it and report `true` ([P20]). The
   * activation-focus channel (`applyBagFocus`) calls this first: when it returns
   * `true` the dialog (not the resting editor) is the card's destination and the
   * caller skips its framework/engine focus claim; when `false` the card is at
   * rest and the caller proceeds to focus the editor as before.
   *
   * `keyCardId` is set in TWO places, by design — they are complementary, never
   * conflicting (both write the same activating card id):
   *  1. the provider's deck-store subscription (`syncKeyCard`) is the *structural
   *     authority* — it sets `keyCardId` for every way a card becomes active,
   *     including the initial seed / same-bit case where no `cardDidActivate`
   *     fires;
   *  2. this `adoptKeyCard` (the focus claim) sets it again — idempotent when the
   *     subscription already did, but it also performs the [P20] focus restore and
   *     covers cold-boot ordering where the focus claim can precede the store
   *     notify. Don't "simplify" the `setKeyCard` out of here.
   *
   * `opts.modality: "keyboard"` declares the activation a keyboard gesture
   * (Cmd-L, pane cycling): the adopted card's retained key view is re-asserted
   * as a keyboard destination — ring, reveal, keyboard landing, stale-descend
   * healing — via {@link FocusContext.assertKeyboardDestination}. A `true`
   * return then also covers that landing, so the activation channel skips its
   * framework/engine claim exactly as it does for a restored dialog.
   */
  adoptKeyCard(cardId: string, opts?: { modality?: FocusModality }): boolean {
    this.setKeyCard(cardId);
    const ctx = this.activeContext();
    // (The first-responder axis is restored in `setKeyCard` above — the universal
    // activation signal — so it covers pane-frontmost promotion too, not just the
    // card-level focus claim this method performs.)
    if (opts?.modality === "keyboard") {
      this.lastInputSource = "keyboard";
      const landed = ctx.assertKeyboardDestination();
      // The pushed-destination truth is re-read AFTER the assert: the heal
      // may have popped a stale descend that would otherwise have counted as
      // a pending destination and silently swallowed the landing.
      return landed || ctx.hasPushedKeyDestination();
    }
    const hasDialog = ctx.hasPushedKeyDestination();
    if (hasDialog) ctx.focusKeyView();
    return hasDialog;
  }

  /**
   * The first-responder axis of the ACTIVATION pass — the framework half of
   * [P21], run from `setKeyCard` (the universal activation signal, its ONE
   * call site): settle the chain's first responder on a responder that
   * serves the key card — the key view's responder; for a never-focused
   * card, the responder owning its default-focus target (the
   * card-author-tagged priority chain `traceApplyDefaultFocus` walks); as a
   * last resort, the card's own container responder (Cmd-W must still land).
   *
   * This deliberately lives in `setKeyCard` rather than `place()`: store-
   * driven activations (the provider's `syncKeyCard` subscription — pane
   * frontmost changes, pane cycling) reach `setKeyCard` without a `place()`
   * call, and the accelerator settlement must cover them too. It is not a
   * cross-writer reconciliation anymore — it is the FR half of the one
   * activation primitive, with no second writer to drift from.
   *
   * The CONTENT half is the em-card engine-hook contract
   * ([lifecycle-delegates.md]): the card registers an engine hook whose
   * `paintMirrorAsActive` focuses its text surface, and the framework's
   * single focus channel (`applyBagFocus`) invokes it — on the activation
   * route, and again via `CardHost`'s `subscribeEngineHooksChange` retry when
   * the editor binds late (create-before-mount, async file load). The
   * `focusin` from that focus promotes the content responder, so late-mounting
   * content settles the chain register itself through the established channel;
   * the engine never observes chain registrations, and no `cardDidActivate`
   * reclaim runs.
   *
   * **Yield rules — who keeps first responder.** Containment is REGISTRY
   * containment (`chain.nodeIsWithin`, the `parentId` walk), never DOM
   * containment, so a pane-modal sheet portaled outside the card's DOM
   * subtree but chain-parented into it counts as serving the card:
   *
   *  - FR already within the key card and NOT a chain ancestor of the
   *    ideal target (a finer promotion, a sibling editor the user clicked,
   *    a modal surface holding focus) → keep it.
   *  - FR is a chain ANCESTOR of the target (the card/pane container a
   *    chrome click or a pre-mount `addCard` promotion left) → the coarse
   *    container is masking the card's content accelerators; promote.
   *  - FR outside the key card entirely (stranded on a previous card, on
   *    the canvas after an unregister cascade, or null) → promote.
   */
  private settleFirstResponderForActivation(): void {
    const chain = this.chain;
    if (chain === null || typeof document === "undefined") return;
    const cardId = this.keyCardId;
    if (cardId === null) return;
    const currentFr = chain.getFirstResponder();

    // The ideal target, best first: the key view's responder…
    let target: string | null = null;
    const keyViewId = this.activeContext().keyView();
    if (keyViewId !== null) {
      target = chain.hasResponder(keyViewId) ? keyViewId : null;
      if (target === null) {
        const el = this.elementForFocusKey(keyViewId);
        target = el ? chain.findResponderForTarget(el) : null;
      }
    }
    const cardEl = document.querySelector<HTMLElement>(
      `[data-card-id="${cssEscapeId(cardId)}"]`,
    );
    // …else the default target's responder (never-focused card). The card's own
    // registry answers first; the DOM chain covers cards with no registered
    // focusables (raw native controls, engine-less bootstraps) and cards whose
    // children have not registered yet when this settle runs.
    if (target === null && cardEl !== null) {
      const el =
        this.defaultFocusableForCard(cardId)?.el ??
        resolveDefaultFocusTarget(cardEl).el;
      target = el ? chain.findResponderForTarget(el) : null;
    }
    // …else the card's own container responder (Cmd-W must still land).
    if (target === null && cardEl !== null) {
      const inner = cardEl.querySelector("[data-responder-id]");
      target = inner ? chain.findResponderForTarget(inner) : null;
    }
    if (target === null || target === currentFr) return;

    const promote =
      currentFr === null ||
      !chain.nodeIsWithin(currentFr, cardId) ||
      chain.nodeIsWithin(target, currentFr);
    if (promote && chain.getFirstResponder() !== target) {
      chain.makeFirstResponder(target);
    }
  }

  /** The element carrying a focus key — a responder id or a focusable id. */
  private elementForFocusKey(id: string): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const esc = cssEscapeId(id);
    return document.querySelector<HTMLElement>(
      `[data-responder-id="${esc}"], [data-tug-focusable="${esc}"]`,
    );
  }

  // ---- Chain attachment ----

  /**
   * Bind the responder chain so `focusKeyViewViaContract` /
   * `restoreFirstResponder` / `settleFirstResponderForActivation` can reach it. The
   * provider calls this from the same `useLayoutEffect` that installs the
   * chain's document listeners, and `detach` from its cleanup. The key view
   * is NOT seeded from chain notifications: only placements write it — the
   * chain register can move with no focus event (`makeFirstResponder`), and
   * such a move carries no keyboard-position information.
   */
  attach(chain: ResponderChainManager): void {
    this.chain = chain;
  }

  /** Release the chain reference. Safe to call when not attached. */
  detach(): void {
    this.chain = null;
  }

  // ---- Keyboard-route enforcement (the watchdog, Spec S03) ----
  //
  // `document.activeElement` is a peripheral register with no interception
  // point — substrates, Radix, and WebKit's own defaults can write it at any
  // moment. The engine therefore never DERIVES state from it; it ENFORCES
  // state onto it. Per route there is exactly one legal answer: the key sink
  // (engine-routed), the granted surface or a descendant (dom-granted), or
  // the key-view element itself (accessibility mode). The watchdog computes
  // the legal element from current engine state at check time and reasserts
  // on sight — it never adopts what it finds. A steal cannot steal the
  // keyboard (keys never routed through the stolen register), so
  // reassertion is cleanup, not conflict resolution.

  /**
   * Trigger enforcement: called by the provider's `focusin`/`focusout`
   * capture listeners, microtask-coalesced through
   * {@link scheduleFocusInvariantCheck} so it always sees settled state.
   */
  enforceKeyboardRoute(reason: string): void {
    this.scheduleFocusInvariantCheck(reason);
  }

  /**
   * Focus a key view through its responder **focus contract** when it is a
   * registered responder — the single, complete focus authority. A substrate
   * with a non-trivial focus surface (the prompt editor's CodeMirror
   * `view.focus()`, a contenteditable, a shadow-DOM host) declares a `focus`
   * callback on `useResponder` ([D03] #focus-contract); `chain.focusResponder`
   * invokes it so DOM focus lands on the right element. The focus *engine* must
   * not re-implement this — its generic DOM walk cannot focus a CodeMirror caret
   * — so `focusKeyView` delegates here first. Returns whether the contract path
   * applied; `false` (the key view is a focusable-only stop, not a responder)
   * leaves the caller to its DOM-walk fallback. No-op without a chain.
   */
  focusKeyViewViaContract(keyViewId: string): boolean {
    if (this.chain === null || !this.chain.hasResponder(keyViewId)) return false;
    this.chain.focusResponder(keyViewId);
    return true;
  }

  /**
   * Settle the chain's first-responder register on `id` WITHOUT moving DOM
   * focus — the already-focused half of a grant ({@link
   * FocusContext.grantTextSurface}'s idempotency path). No-op when the id
   * is not a registered responder or already first.
   */
  settleResponderRegister(id: string): void {
    if (this.chain === null || !this.chain.hasResponder(id)) return;
    if (this.chain.getFirstResponder() === id) return;
    this.chain.makeFirstResponder(id);
  }

  /**
   * Settle the chain's first responder onto the CURRENT key view's nearest
   * responder — the engine-placement half of what `focusin` promotion used
   * to do when key views held real DOM focus. An engine-routed placement
   * parks the sink (which carries no responder and fires no useful
   * `focusin`), so the register must track the key view explicitly, or
   * responder-scoped dispatch (accelerators, the cancel ladder) strands on
   * whatever coarse container the activation settle left (the rail's
   * Escape focus-out lives on a content-local responder the upward walk
   * only reaches when FR starts at or below it).
   */
  settleResponderForKeyView(): void {
    if (this.chain === null || typeof document === "undefined") return;
    const keyViewId = this.activeContext().keyView();
    if (keyViewId === null) return;
    if (this.chain.hasResponder(keyViewId)) {
      this.settleResponderRegister(keyViewId);
      return;
    }
    const el = this.elementForFocusKey(keyViewId);
    if (el === null) return;
    const responder = this.chain.findResponderForTarget(el);
    if (responder !== null && this.chain.getFirstResponder() !== responder) {
      this.chain.makeFirstResponder(responder);
    }
  }

  /**
   * Whether `id` names a registered responder that declared a `focus`
   * contract ([D03]) — the structural declaration the keyboard-route
   * classification reads (Spec S02). `false` without a chain: with no
   * responder registry there are no text surfaces to grant to.
   */
  responderHasFocusContract(id: string): boolean {
    return this.chain?.responderHasFocusContract(id) ?? false;
  }

  /**
   * Whether a `responder`-kind target can be realized right now ([P06]
   * resolve half): the id names a registered responder node, or a connected
   * DOM element carries it as `data-responder-id`. Permissive when neither
   * a chain nor a document exists (bare-manager pure-logic suites): with no
   * registry there is nothing to contradict the placement.
   */
  responderTargetResolvable(id: string): boolean {
    if (this.chain !== null && this.chain.hasResponder(id)) return true;
    if (typeof document === "undefined") return this.chain === null;
    const el = document.querySelector(
      `[data-responder-id="${cssEscapeId(id)}"]`,
    );
    if (el !== null && el.isConnected) return true;
    // A chain is attached and doesn't know the id, and no element carries
    // it: unrealizable.
    return this.chain === null;
  }

  /**
   * The keyboard route of the active context's current target (Spec S02) —
   * the mode every key listener and the watchdog read.
   */
  keyboardRoute(): KeyboardRoute {
    return this.activeContext().keyboardRoute();
  }

  /**
   * Deliver a key to the active context's key-view delegate (Spec S04). The
   * provider's `keyViewDelegateListener` calls this after the walk / spatial /
   * bindings / act stages decline a key. Structurally gated: never in
   * dom-granted mode (the granted surface really holds DOM focus and owns its
   * keys) and never for ⌃ or ⌘ chords (bindings territory).
   *
   * ⌘ + a MOVEMENT key is the one exception, and it is a narrow one. Those keys
   * are bound to no command anywhere in the registry — a bare-⌘ arrow has never
   * meant anything in this app — while a multi-select list needs them to mean
   * "walk the cursor without disturbing the selection", which is a statement
   * about a surface's own contents and could not be a global binding if it
   * tried. Everything else with ⌘ still stops here, and ⌃ stops unconditionally.
   */
  dispatchKeyToKeyView(event: KeyboardEvent): boolean {
    if (event.ctrlKey) return false;
    if (event.metaKey && !isMovementKey(event.key)) return false;
    if (this.keyboardRoute() === "dom-granted") return false;
    return this.activeContext().dispatchKeyToKeyView(event);
  }

  /**
   * Park `document.activeElement` on the engine-owned key sink (Spec S01).
   * Idempotent (a no-op when the sink is already active); `preventScroll`
   * on the focus write like every engine focus move ([D07]). Parking is
   * hygiene, not a routing precondition — keys route from the engine's
   * target whether or not the park has landed ([P04]). Returns whether the
   * sink holds focus after the call.
   */
  parkKeySink(): boolean {
    if (typeof document === "undefined") return false;
    const sinks = document.querySelectorAll<HTMLElement>(
      `[${KEY_SINK_ATTRIBUTE}]`,
    );
    if (sinks.length === 0) return false;
    const sink = this.sinkForKeyView() ?? sinks[sinks.length - 1];
    if (document.activeElement === sink) return true;
    sink.focus({ preventScroll: true });
    return document.activeElement === sink;
  }

  /**
   * The sink a park of the CURRENT key view must land on: the one nearest it in
   * the tree, found by walking up from the key-view element and taking the
   * first ancestor whose subtree holds a sink. `null` when there is no key view
   * in the DOM, or no sink above it — the caller then falls back to document
   * order.
   *
   * Innermost has to mean *nearest the key view*, not *last in the document*.
   * A focus-jailing surface (a Radix-modal trap) hosts its own sink inside the
   * jail precisely so the park never crosses the jailer's boundary, and
   * document order does not answer that question: the jail is portalled into
   * the canvas overlay root, while the deck's own sink is rendered after that
   * root and therefore sorts last. Parking outside the jail from a key view
   * inside it left the surface's Tab walk stuck on the stop it had reached —
   * the keydown was arriving from outside the trapped mode.
   */
  private sinkForKeyView(): HTMLElement | null {
    const keyViewEl = this.activeContext().keyViewElement();
    if (keyViewEl === null) return null;
    let node: HTMLElement | null = keyViewEl;
    while (node !== null) {
      const inner = node.querySelector<HTMLElement>(`[${KEY_SINK_ATTRIBUTE}]`);
      if (inner !== null) return inner;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * The element carrying an added `tabindex="-1"` from the last
   * accessibility-mode mirror grant, or `null`. Engine-routed key views
   * render with no tabindex; the mirror adds one at grant time and removes
   * it when the mirror moves on, so a return to `standard` mode leaves no
   * stray tabindex'd elements for WebKit's mousedown focus default to land
   * on.
   */
  private mirroredTabindexEl: HTMLElement | null = null;

  /**
   * Accessibility-mode grant ([P10]): move real DOM focus to the active
   * context's key-view element so assistive tech tracks the engine's key
   * view natively — real focus on real widgets is the one pattern every AT
   * handles. The element regains a `tabindex="-1"` at grant time when it
   * renders without one; `preventScroll` like every engine focus write
   * ([D07]). Idempotent: focus already on (or inside) the key-view element
   * is left alone. Returns whether the key view holds focus after the call.
   */
  mirrorKeyViewFocus(): boolean {
    if (typeof document === "undefined") return false;
    const keyViewId = this.activeContext().keyView();
    const el = keyViewId !== null ? this.elementForFocusKey(keyViewId) : null;
    if (el === null) return false;
    if (this.mirroredTabindexEl !== null && this.mirroredTabindexEl !== el) {
      this.mirroredTabindexEl.removeAttribute("tabindex");
      this.mirroredTabindexEl = null;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && (el === active || el.contains(active))) {
      return true;
    }
    if (!el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "-1");
      this.mirroredTabindexEl = el;
    }
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  }

  /**
   * Remove the mirror's added `tabindex` bookkeeping — called when the
   * keyboard-access mode returns to `standard`, so the no-tabindex render
   * doctrine holds again by construction.
   */
  private clearMirrorArtifacts(): void {
    if (this.mirroredTabindexEl !== null) {
      this.mirroredTabindexEl.removeAttribute("tabindex");
      this.mirroredTabindexEl = null;
    }
  }

  /**
   * The chain's current first responder id, or `null` — read by a context's
   * {@link FocusContext.pushFocusMode} to capture the first-responder axis of the
   * focus state, so the matching pop can restore it ([#cfrunloop-model]). `null`
   * without a chain.
   */
  firstResponder(): string | null {
    return this.chain?.getFirstResponder() ?? null;
  }

  /**
   * Restore the chain's first responder to `id` as the first-responder axis of a
   * focus-mode pop — the structure-level counterpart to {@link focusKeyView}'s DOM
   * re-projection. A trapped surface may claim first responder on open so its own
   * keyboard cancel (Cmd-.) reaches it (a modal confirm popover does, since its
   * `data-tug-focus="refuse"` buttons never promote); restoring the responder
   * captured at push returns action dispatch to where the user was — so a
   * "leave the responder as-is" close path (the engine-owns restore for a
   * focus-refusing key view) is correct even when the surface displaced it. No-op
   * without a chain, when `id` is no longer registered (the prior responder
   * unmounted with its own surface), or when it is already first. A chain-head
   * change fires no focus event, so it cannot disturb the key view restored
   * alongside it (the key view derives from DOM focus, not chain state).
   */
  restoreFirstResponder(id: string): void {
    if (this.chain === null) return;
    if (!this.chain.hasResponder(id)) return;
    if (this.chain.getFirstResponder() === id) return;
    this.chain.makeFirstResponder(id);
  }

  // ---- Placement (the single focus-write primitive) ----

  // The input-source latch: the last real user input modality, consulted when
  // a placement does not assert one and by the settled-focus derivation.
  // Seeded `pointer` — a placement that wants the ring asserts `keyboard`
  // explicitly; an un-asserted pre-input focus (an engine caret at cold boot)
  // must not ring.
  private lastInputSource: FocusModality = "pointer";

  /** Record the input source of a real user event (provider capture listeners). */
  noteInputSource(source: FocusModality): void {
    this.lastInputSource = source;
  }

  /** The last real user input modality — the ring's default flavor. */
  inputSource(): FocusModality {
    return this.lastInputSource;
  }

  /**
   * THE focus-write primitive: record `target` as the card's focus
   * destination and — iff that card is the key card — realize it (set the
   * key view, move DOM focus, project the ring) in one atomic pass.
   *
   * Every path that used to pair `setKeyView(id, true)` with
   * `focusKeyView()` calls this instead; the pair is the drift-prone shape
   * (a paint half and a focus half that different code updates on different
   * schedules), and this primitive is the only place the two halves meet.
   *
   * The latch is set BEFORE the DOM focus move: `el.focus()` fires
   * `focusin` synchronously, and the projection derives the ring's flavor
   * from the latch inside that event.
   *
   * A `cardId` of `null` places against the active context (chrome around
   * the key card / the default context) — the historical behavior of the
   * param-free engine methods.
   */
  place(
    cardId: string | null,
    target: FocusTarget,
    opts?: PlaceOptions,
  ): PlaceResult {
    const ctx = this.contextFor(cardId);
    ctx.recordTarget(target);
    if (opts?.activation === true && cardId !== null) {
      this.setKeyCard(cardId);
    }
    if (!this.isActiveContext(ctx)) {
      // Not the key card: no DOM side effects ([P05]). The registry kinds
      // still realize their CACHE half (projection and focus are
      // active-gated inside the context), so a background card's dialog
      // seed is its saved key view when activation restores it ([P20]).
      // The `engine` and `state-key` kinds have un-gated DOM effects and
      // stay record-only until activation.
      if (
        target.kind === "focusable" ||
        target.kind === "focus-key" ||
        target.kind === "responder"
      ) {
        ctx.realizeTarget(target, opts?.modality ?? this.lastInputSource, {
          arrival: opts?.arrival,
        });
      }
      tugDevLogStore.debug(
        "focus-place",
        `recorded (not key card): ${target.kind} for card ${ctx.cardId ?? "(default)"} while key card is ${this.keyCardId ?? "(none)"}`,
        { target, cardId: ctx.cardId, keyCard: this.keyCardId },
      );
      return "recorded";
    }
    const modality = opts?.modality ?? this.lastInputSource;
    this.lastInputSource = modality;
    const result = ctx.realizeTarget(target, modality, {
      preventScroll: opts?.preventScroll,
      arrival: opts?.arrival,
    });
    // A fresh placement is a new claim — it starts a new enforcement
    // episode with a full reassert budget.
    this.resetReassertEpisode();
    this.scheduleFocusInvariantCheck("place");
    return result;
  }

  // ---- Enforcement + report (guard-as-enforcement, Spec S03) ----
  //
  // `violations` is reserved for genuine incoherence the watchdog cannot fix
  // (a dom-granted route whose granted surface is gone — corrected by
  // falling the route back to engine-routed, but reported loudly).
  // `reasserted` counts corrections; `steals` is the per-offender ledger —
  // the trap for present and future raw focus writes. A corrected steal is
  // never silently absorbed: any offender that is not known-benign browser
  // churn logs at `warn` in the dev panel. Checks are microtask-coalesced
  // so a paint-then-focus pair inside one task is observed only in its
  // settled state, and reassertion is signature-deduped so a stable
  // offender logs once per episode. No `document.hasFocus()` gate: state
  // coherence is checked regardless of OS focus, and the park `.focus()` is
  // attempted regardless (it sets `activeElement` even in an unfocused
  // document).

  private invariantViolationCount = 0;
  private reassertedCount = 0;
  private stealsByOffender: Map<string, number> = new Map();
  private lastInvariantViolation: {
    ringed: string;
    active: string;
    keyCard: string | null;
    reason: string;
  } | null = null;
  private lastInvariantSignature: string | null = null;
  private invariantCheckQueued = false;
  /**
   * Consecutive reasserts without an intervening legal pass — the
   * episode counter behind {@link REASSERT_BUDGET}. A correction whose
   * target is stolen back by a peer focus enforcer (a trapped Radix
   * FocusScope whose in-jail sink is momentarily unmounted mid-HMR)
   * would otherwise re-trigger the watchdog on its own `focusin`
   * forever. Reset on every legal/exempt pass and on every placement.
   */
  private reassertEpisodeCount = 0;
  private reassertBudgetExhausted = false;
  private static readonly REASSERT_BUDGET = 4;

  /**
   * Queue a coalesced enforcement pass; safe to call from any writer.
   *
   * A MACROTASK, deliberately. The check's own reassert (`park` /
   * `regrant` / mirror) fires a synchronous `focusin` whose capture
   * listener re-schedules this check. On a microtask the re-entry joins
   * the CURRENT drain — and a peer that synchronously steals focus back
   * turns the pair into an infinite non-yielding loop that starves the
   * main thread and blocks the very React commit (an HMR remount, a
   * dialog close) that would remove the opponent. A macrotask yields to
   * the event loop between passes, and {@link REASSERT_BUDGET} bounds
   * the episode, so the worst case is a few corrections and one loud
   * error — never a hang. Still coalesced: one pending check at a time,
   * observing settled state.
   */
  scheduleFocusInvariantCheck(reason: string): void {
    if (typeof document === "undefined") return;
    if (this.invariantCheckQueued) return;
    this.invariantCheckQueued = true;
    window.setTimeout(() => {
      this.invariantCheckQueued = false;
      this.checkFocusInvariant(reason);
    }, 0);
  }

  /** A legal / exempt pass or a fresh placement ends the episode. */
  private resetReassertEpisode(): void {
    this.reassertEpisodeCount = 0;
    this.reassertBudgetExhausted = false;
  }

  /**
   * The watchdog's cumulative report — read by the test surface. App-tests
   * assert `violations === 0` (the engine never lied) and steal BUDGETS
   * (`steals` stays flat across interactions where no raw focus write
   * should occur).
   */
  focusInvariantReport(): {
    violations: number;
    reasserted: number;
    steals: Record<string, number>;
    last: {
      ringed: string;
      active: string;
      keyCard: string | null;
      reason: string;
    } | null;
  } {
    return {
      violations: this.invariantViolationCount,
      reasserted: this.reassertedCount,
      steals: Object.fromEntries(this.stealsByOffender),
      last: this.lastInvariantViolation,
    };
  }

  /**
   * Derive the complete DOM projection of the current engine state — every
   * focus mark AND the one legal `activeElement`, from one computation.
   *
   * Side-effect-free: it reads engine state and the document, and writes
   * nothing. {@link reproject} applies it; the watchdog reconciles against it.
   * Because it derives from STATE rather than from a transition, any caller may
   * run it at any time and get the same answer — which is what makes a
   * transient key-card change recoverable instead of a wipe nothing restamps.
   */
  computeProjection(): FocusProjection {
    const ctx = this.activeContext();
    const state = ctx.projectionState();
    const keyViewEl = ctx.keyViewElement();
    const keyWithinEl =
      state.keyWithinId === null
        ? null
        : this.elementForFocusKey(state.keyWithinId);
    // The default ring and the key view track the same signal, so they are
    // derived in lockstep ([P14] one filled+ring per scope): the ring shows on
    // the top of the stack unless the key view is itself a button.
    const ringTop = ctx.defaultRingTop();
    return {
      ...state,
      keyViewEl,
      // The focus ring paints on a keyboard-reached key view (the engine's own
      // signal, since `:focus-visible` is unreliable for programmatic focus) —
      // and, when the ring-follows-pointer policy is on, on any pointer-driven
      // key-view change too.
      // …and only while KBF mode is PAINTING ([P04] mechanism 1) — engaged
      // with no caret granted. This is the whole ring gate: `focus-ring.css`
      // calls this attribute "One trigger", and it is exactly that — a pure
      // paint signal, not a position record. Withholding it here stands ~40
      // selectors across ~20 component stylesheets down at once with NO
      // cascade change, where prefixing the paint rules with `html[data-kbf]`
      // would raise them above every item-group suppression and repaint the
      // double ring ([R04]). The unflavored `data-key-view` is untouched, so
      // every behavioral reader — the engine-leaf delivery, the watchdog —
      // sees no change.
      keyViewKbd:
        (state.keyViewKeyboard || this.ringFollowsPointer) &&
        this.kbfPainting(),
      kbf: this.kbfPainting(),
      keyWithinEl,
      defaultRingEl: ringTop !== null && !ctx.keyViewIsButton() ? ringTop : null,
      legalActive: this.legalKeyboardElement().legal,
    };
  }

  /**
   * Converge the DOM onto {@link computeProjection}'s answer.
   *
   * Diff-then-write per mark: a mark is removed only from elements that should
   * not carry it and set only where it is missing, so a reprojection that
   * changes nothing writes nothing. The clear pass is document-wide rather than
   * scoped to the active context's own elements — that is what wipes a stale
   * mark left behind by a just-deactivated context (a Done button keeping its
   * ring after another pane took focus).
   *
   * Gated on having a document. The active-context gate lives in
   * {@link FocusContext.reproject}: contexts call through there, and the
   * coordinator's own call sites are already operating on the active context.
   */
  reproject(): void {
    if (this.applyProjection() === null) return;
    // Every projection is a promise about where the keyboard is; verify it once
    // the surrounding task's paint-then-focus pair has settled.
    this.scheduleFocusInvariantCheck("projection");
  }

  /**
   * The convergence pass itself, without the follow-up invariant check.
   *
   * Returns how many mark writes it had to make — `0` when the DOM already
   * agreed with engine state, which is the steady-state answer. The reconciler
   * calls this directly (rather than {@link reproject}) so that healing a mark
   * cannot schedule the check that is currently running. `null` means there was
   * no document to converge.
   */
  private applyProjection(): number | null {
    if (typeof document === "undefined") return null;
    const p = this.computeProjection();
    let writes = 0;

    for (const el of document.querySelectorAll<HTMLElement>("[data-key-view]")) {
      if (el !== p.keyViewEl) {
        el.removeAttribute(KEY_VIEW_ATTRIBUTE);
        el.removeAttribute("data-key-view-kbd");
        writes += 1;
      }
    }
    if (p.keyViewEl !== null && p.keyViewId !== null) {
      if (p.keyViewEl.getAttribute(KEY_VIEW_ATTRIBUTE) !== p.keyViewId) {
        p.keyViewEl.setAttribute(KEY_VIEW_ATTRIBUTE, p.keyViewId);
        writes += 1;
      }
      const hasKbd = p.keyViewEl.hasAttribute("data-key-view-kbd");
      if (p.keyViewKbd && !hasKbd) {
        p.keyViewEl.setAttribute("data-key-view-kbd", "");
        writes += 1;
      } else if (!p.keyViewKbd && hasKbd) {
        p.keyViewEl.removeAttribute("data-key-view-kbd");
        writes += 1;
      }
    }

    for (const el of document.querySelectorAll<HTMLElement>(
      `[${KEY_WITHIN_ATTRIBUTE}]`,
    )) {
      if (el !== p.keyWithinEl) {
        el.removeAttribute(KEY_WITHIN_ATTRIBUTE);
        writes += 1;
      }
    }
    if (p.keyWithinEl !== null && !p.keyWithinEl.hasAttribute(KEY_WITHIN_ATTRIBUTE)) {
      p.keyWithinEl.setAttribute(KEY_WITHIN_ATTRIBUTE, "");
      writes += 1;
    }

    for (const el of document.querySelectorAll<HTMLElement>("[data-default-ring]")) {
      if (el !== p.defaultRingEl) {
        el.removeAttribute("data-default-ring");
        writes += 1;
      }
    }
    if (p.defaultRingEl !== null && !p.defaultRingEl.hasAttribute("data-default-ring")) {
      p.defaultRingEl.setAttribute("data-default-ring", "");
      writes += 1;
    }

    const root = document.documentElement;
    const hasKbf = root.hasAttribute(KBF_ATTRIBUTE);
    if (p.kbf && !hasKbf) {
      root.setAttribute(KBF_ATTRIBUTE, "");
      writes += 1;
    } else if (!p.kbf && hasKbf) {
      root.removeAttribute(KBF_ATTRIBUTE);
      writes += 1;
    }
    if (p.focusMode === null) {
      if (root.hasAttribute(FOCUS_MODE_ATTRIBUTE)) {
        root.removeAttribute(FOCUS_MODE_ATTRIBUTE);
        writes += 1;
      }
    } else if (root.getAttribute(FOCUS_MODE_ATTRIBUTE) !== p.focusMode) {
      root.setAttribute(FOCUS_MODE_ATTRIBUTE, p.focusMode);
      writes += 1;
    }

    // Accessibility mode ([P10]): every projection of an engine-routed key view
    // re-mirrors real DOM focus onto it. Arrow-roving moves the key view
    // without a placement, so the projection is the one choke point that sees
    // every move. `mirrorKeyViewFocus` is a no-op when the grant already holds,
    // so this does not count as a write.
    if (
      p.keyViewEl !== null &&
      p.route === "engine-routed" &&
      this.accessMode === "accessibility"
    ) {
      this.mirrorKeyViewFocus();
    }

    if (process.env.NODE_ENV !== "production") {
      this.checkReturnPromiseInvariant();
    }
    return writes;
  }

  /**
   * Dev-only invariant: **at most one control on screen may promise Return**
   * ([#chord-ring]).
   *
   * The double ring says "Return fires this" and the chord variant says
   * "Return fires this once the modifier is down"; both are claims on the same
   * key, so two lit at once means one of them is lying and the user has no way
   * to tell which. The claim is currently structural rather than arbitrated —
   * the engine projects `data-default-ring` onto at most one node, and the
   * entry-shell path lights only inside the shell holding the keyboard, so the
   * two cannot coincide. Structural is not the same as checked, and this is
   * the check.
   *
   * Deliberately NOT an arbitration. Promoting the entry-shell path into the
   * engine's default-ring stack would be the other way to guarantee it, and
   * [P14] rules it out: that stack holds STANDING mount-scoped claims, and two
   * mounted shells would contend for one slot to express something that is not
   * standing at all.
   *
   * Signature-deduped so a steady collision reports once rather than once per
   * reprojection, the same shape as the caret invariants in `caret-layer.ts`.
   */
  private checkReturnPromiseInvariant(): void {
    if (typeof document === "undefined") return;
    const enabled = ":not(:disabled):not([aria-disabled='true'])";
    const wearers = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-default-ring]${enabled},` +
          `.tug-entry-shell[data-entry-keyboard] [data-tug-entry-default]${enabled}`,
      ),
    );
    const signature =
      wearers.length <= 1
        ? "ok"
        : wearers
            .map(
              (el) =>
                el.getAttribute("data-testid") ??
                el.getAttribute("aria-label") ??
                el.className,
            )
            .join(" | ");
    if (this.lastReturnPromiseSignature === signature) return;
    this.lastReturnPromiseSignature = signature;
    if (wearers.length <= 1) return;

    deckTrace.record({
      kind: "return-promise-collision",
      count: wearers.length,
      wearers: signature,
    });
    console.error(
      `[tugways] ${wearers.length} controls are promising Return at once ` +
        `(${signature}) — the double ring speaks for one key and only one ` +
        `control may claim it.`,
    );
  }

  /** Last {@link checkReturnPromiseInvariant} answer, for its dedupe. */
  private lastReturnPromiseSignature = "";

  /**
   * Resolve the one legal `activeElement` for the current engine state
   * (Spec S03) — the register half of {@link computeProjection}, which is its
   * only caller. `null` for dom-granted means the granted surface is GONE: the
   * incoherence case the reconciler reports rather than corrects.
   */
  private legalKeyboardElement(): {
    legal: HTMLElement | null;
    route: KeyboardRoute;
  } {
    const ctx = this.activeContext();
    const route = ctx.keyboardRoute();
    // With no document there is no register to be legal or illegal; the route
    // is still real engine state, so it is reported.
    if (typeof document === "undefined") return { legal: null, route };
    // Accessibility mode ([P10]): real DOM focus mirrors the engine-routed
    // key view. Dom-granted routes keep their standard resolution — the
    // granted surface already IS real DOM focus, and the key view can lag
    // the focusin promotion for `engine` / `state-key` targets.
    if (this.accessMode === "accessibility" && route === "engine-routed") {
      const keyViewId = ctx.keyView();
      const el = keyViewId !== null ? this.elementForFocusKey(keyViewId) : null;
      return { legal: el, route };
    }
    if (route === "dom-granted") {
      const target = ctx.target();
      if (target.kind === "state-key") {
        const scope =
          ctx.cardId !== null
            ? document.querySelector(
                `[data-card-id="${cssEscapeId(ctx.cardId)}"]`,
              )
            : document;
        return {
          legal:
            scope?.querySelector<HTMLElement>(
              `[data-tug-state-key="${cssEscapeId(target.key)}"]`,
            ) ?? null,
          route,
        };
      }
      if (target.kind === "engine") {
        // The engine hook owns its own focus surface; the card element is
        // the containment boundary the engine can name.
        const cardEl =
          ctx.cardId !== null
            ? document.querySelector<HTMLElement>(
                `[data-card-id="${cssEscapeId(ctx.cardId)}"]`,
              )
            : null;
        return { legal: cardEl, route };
      }
      const keyViewId = ctx.keyView();
      return {
        legal: keyViewId !== null ? this.elementForFocusKey(keyViewId) : null,
        route,
      };
    }
    const sinks = document.querySelectorAll<HTMLElement>(
      `[${KEY_SINK_ATTRIBUTE}]`,
    );
    return {
      legal: sinks.length > 0 ? sinks[sinks.length - 1] : null,
      route,
    };
  }

  /**
   * Whether `el` is a bare native form control — an `<input>` / `<textarea>`
   * / `<select>` whose nearest responder ancestor declares NO focus
   * contract. Such controls are the `state-key` CLASS of [P02] (text
   * surfaces by nature) even when they carry no engine identity the target
   * union can name, so holding focus on one is always legal. A
   * `contenteditable` never gets this pass: editors are contract-bound
   * substrates, and an uncontracted contenteditable holding focus is
   * exactly the steal class the watchdog exists to correct.
   *
   * Coordinator-facing: `FocusContext.focusKeyView` reads the same
   * predicate so the engine GRANTS DOM focus to exactly the element
   * class the watchdog will not correct — grant and legality stay
   * symmetric.
   */
  isBareNativeControl(el: HTMLElement): boolean {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
    const responderEl = el.closest<HTMLElement>("[data-responder-id]");
    if (responderEl === null) return true;
    const id = responderEl.getAttribute("data-responder-id");
    return id === null || !this.responderHasFocusContract(id);
  }

  /**
   * True while a pointer gesture whose activation the pane-focus-controller
   * DEFERRED is in flight (a gesture on draggable content in a background
   * card — see focus-language.md § Drag and the keyboard).
   *
   * Such a gesture deliberately leaves the browser's mousedown focus default
   * alone, because a prevented mousedown never begins a native drag. The
   * default then walks up from the click target and focuses the nearest
   * tabindex'd ancestor — a background card's container — which the watchdog
   * corrects on its next pass. That correction is browser churn from a
   * gesture the engine chose to let through, not a raw focus write by our
   * code, so it is corrected QUIETLY: same class as the browser focusing the
   * engine's own stop. Attributing it as a steal would mean every jot
   * drag ledgered a warn that no writer could ever fix.
   */
  private deferredGestureActive = false;

  /** Open the browser-default focus window for a deferred pointer gesture. */
  beginDeferredGesture(): void {
    this.deferredGestureActive = true;
  }

  /** Close it — on drag start, on gesture abandon, or after the commit. */
  endDeferredGesture(): void {
    this.deferredGestureActive = false;
  }

  /**
   * Ledger a correction the watchdog wanted to run but could not.
   *
   * Corrections never fail silently (focus-language.md § One writer, "The
   * watchdog is enforcement, not observation"): a watchdog that classifies a
   * steal correctly and then no-ops without a trace converts a caught bug
   * into an uncaught one. The entry rides the same steal ledger the dev panel
   * surfaces and app-tests budget-assert, so a failed correction is a test
   * failure for free. The offender key names the correction, not an element —
   * the element is in the log payload.
   */
  private ledgerFailedCorrection(
    correction: string,
    detail: { offender: string; legal: string; route: KeyboardRoute; reason: string },
  ): void {
    const key = `(correction failed: ${correction})`;
    this.stealsByOffender.set(key, (this.stealsByOffender.get(key) ?? 0) + 1);
    tugDevLogStore.warn(
      "focus-watchdog",
      `correction failed: ${correction} — the illegal focus stands (${detail.reason})`,
      detail,
    );
  }

  /**
   * The projection reconciler: recompute the projection from engine state,
   * diff it against the DOM, and write back the difference — for the marks and
   * for `document.activeElement` alike.
   *
   * Both halves answer to {@link computeProjection}, so the marks and the legal
   * register can no longer drift from each other: they are fields of one
   * record. The marks are healed unconditionally and quietly (drift is not a
   * steal — nothing took the keyboard). The register is the loud half, with the
   * ledger and budget the dev panel and app-tests read.
   *
   * Everything that survives as a special case is a NAMED CONTRACT, marked as
   * such below and documented in `focus-language.md`: grant-lost model repair,
   * standing legality classes (any sink park, bare native controls),
   * jurisdiction, body tolerance, browser churn (the engine's own stop and the
   * deferred-gesture window), and the reassert budget's stand-down. A carve-out
   * that cannot be named is a bug.
   */
  private checkFocusInvariant(reason: string): void {
    if (typeof document === "undefined") return;
    const ctx = this.activeContext();

    // The reconciler's first act: converge the MARKS. Everything the engine
    // projects — key view, ring modality, key-within, focus mode, default ring
    // — is recomputed from state and rewritten where the DOM disagrees. This is
    // the capability the transition-driven syncs never had: a mark stripped by
    // something outside the engine (a React re-render dropping an attribute, a
    // peer script, a wipe from a transient key-card change) is healed on the
    // next pass instead of standing until some unrelated transition happens to
    // restamp it. In the steady state the diff writes nothing.
    const healed = this.applyProjection() ?? 0;
    if (healed > 0) {
      // Mark drift is not a focus steal — nothing took the keyboard, the image
      // of engine state simply fell out of date — so it rides `debug`, not the
      // steal ledger. It is still worth naming: a mark that needs healing every
      // pass means a peer writer, and the count is how that shows up.
      tugDevLogStore.debug(
        "focus-watchdog",
        `reconciled ${healed} focus mark write(s) (${reason})`,
        { writes: healed, keyCard: this.keyCardId, reason },
      );
    }

    const p = this.computeProjection();
    const legal = p.legalActive;
    const route = p.route;
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // NAMED CONTRACT — grant lost. Incoherence the reconciler cannot fix by
    // reprojecting: a dom-granted route whose granted surface is gone. This is
    // MODEL repair, not projection repair — the engine's own state is wrong, so
    // it falls back to engine-routed (the enclosing target keeps routing keys)
    // and reports loudly rather than quietly.
    if (route === "dom-granted" && legal === null) {
      const activeDesc = describeElementForInvariant(active);
      const signature = `grant-lost→${activeDesc}`;
      if (signature !== this.lastInvariantSignature) {
        this.lastInvariantSignature = signature;
        this.invariantViolationCount += 1;
        this.lastInvariantViolation = {
          ringed: "(granted surface gone)",
          active: activeDesc,
          keyCard: this.keyCardId,
          reason,
        };
        tugDevLogStore.warn(
          "focus-invariant",
          `dom-granted route with no granted surface — falling back to engine-routed (${reason})`,
          { active: activeDesc, keyCard: this.keyCardId, reason },
        );
      }
      ctx.noteGrantLost();
      if (this.spendReassertBudget(reason, "(grant-lost park)")) {
        if (!this.parkKeySink()) {
          this.ledgerFailedCorrection("park (no key sink)", {
            offender: activeDesc,
            legal: "(key sink)",
            route,
            reason,
          });
        }
      }
      return;
    }

    const isLegal =
      active !== null &&
      legal !== null &&
      (legal === active || legal.contains(active));
    // NAMED CONTRACT — standing legality classes. The projection names ONE
    // legal element, but two classes are legal wherever they appear:
    //
    //  - ANY key sink is a legal park (a jailing surface hosts its own; see
    //    KEY_SINK_ATTRIBUTE), because parking is hygiene and every sink parks
    //    equally well. In accessibility mode a sink park is legal only while
    //    there is no key view to mirror — with one present, the mirror is the
    //    one legal answer (Spec S03) and a stale park gets corrected onto it.
    //  - A bare native form control is legal by CLASS: it is a text surface by
    //    nature even when it carries no engine identity the target union can
    //    name, and the engine grants focus to exactly this class, so grant and
    //    legality stay symmetric (see `isBareNativeControl`).
    //
    //    That symmetry is why the class stands down while the mode PARKS text
    //    stops ([P12]): `focusKeyView` declines to grant a bare control the
    //    engine moved to, so calling a caret there legal would let a second
    //    focus authority (a Radix mount-autofocus, the browser's own default)
    //    fill the vacuum and have the watchdog bless it — parking would fail
    //    silently, which is exactly the pair Spec S05 says must move together.
    const sinkIsLegalPark =
      active !== null &&
      active.hasAttribute(KEY_SINK_ATTRIBUTE) &&
      !(this.accessMode === "accessibility" && ctx.keyView() !== null);
    if (
      isLegal ||
      sinkIsLegalPark ||
      (active !== null &&
        this.isBareNativeControl(active) &&
        !ctx.parksTextStop())
    ) {
      this.lastInvariantSignature = null;
      this.resetReassertEpisode();
      return;
    }

    // NAMED CONTRACT — jurisdiction. The reconciler governs the ENGINE's
    // universe and nothing else; see {@link governsElement}. Correcting a
    // foreign surface would fight a system the engine knows nothing about.
    if (active !== null && !this.governsElement(active)) {
      this.lastInvariantSignature = null;
      this.resetReassertEpisode();
      return;
    }

    // NAMED CONTRACT — body tolerance. Focus resting on `<body>` / nothing is
    // NOT corrected: parking is
    // hygiene, not a routing precondition ([P04]) — keys route from the
    // engine's target regardless, and placements park at commit time. More
    // load-bearing: a blur-to-body is routinely the TRANSIENT middle of the
    // browser's own mousedown/teardown focus sequence, and writing focus
    // inside that window fights the browser's pending default (the click's
    // focus never lands, a drag-selection anchor is disturbed). The engine
    // only ever corrects a real ELEMENT illegally holding the register.
    if (active === null || active === document.body) {
      this.lastInvariantSignature = null;
      this.resetReassertEpisode();
      return;
    }

    // NAMED CONTRACT — browser churn, corrected quietly. Two cases, both of
    // them the browser doing its job rather than a writer taking the keyboard:
    //
    //  - The engine's own projected key view receiving browser focus (a clicked
    //    stop taking mousedown focus). Ring and router already agree; only the
    //    register is off, so this is a reproject, not a steal.
    //  - The mousedown default of a DEFERRED drag gesture. A prevented
    //    mousedown never begins a native drag, so the engine deliberately lets
    //    the default through and accepts the focus it lands; attributing that
    //    as a steal would ledger a warn on every jot drag that no writer
    //    could fix. The window is opened and closed explicitly by the gesture
    //    owner (`beginDeferredGesture` / `endDeferredGesture`).
    const keyViewEl = p.keyViewEl;
    const ownStop =
      this.deferredGestureActive ||
      (keyViewEl !== null &&
        (keyViewEl === active ||
          keyViewEl.contains(active) ||
          active.contains(keyViewEl)));

    // Reassert the legal element, and ledger the correction. The offender
    // is attributed so a raw focus write introduced next month announces
    // itself in the dev panel instead of being silently absorbed.
    const offender = describeElementForInvariant(active);
    const legalDesc = describeElementForInvariant(legal);
    const signature = `${offender}→${legalDesc}|${route}`;
    if (signature !== this.lastInvariantSignature) {
      this.lastInvariantSignature = signature;
      this.reassertedCount += 1;
      if (ownStop) {
        tugDevLogStore.debug(
          "focus-watchdog",
          `re-${route === "dom-granted" ? "granting" : "parking"} after browser focus on ${this.deferredGestureActive ? "a deferred drag gesture's target" : "the engine's own stop"} ${offender} (${reason})`,
          { offender, legal: legalDesc, route, reason },
        );
      } else {
        this.stealsByOffender.set(
          offender,
          (this.stealsByOffender.get(offender) ?? 0) + 1,
        );
        tugDevLogStore.warn(
          "focus-watchdog",
          `raw focus write corrected: ${offender} took activeElement while the route is ${route}; reasserting ${legalDesc} (${reason})`,
          { offender, legal: legalDesc, route, reason },
        );
      }
    }
    if (!this.spendReassertBudget(reason, `${offender}→${legalDesc}|${route}`)) {
      return;
    }
    const failureDetail = {
      offender,
      legal: legalDesc,
      route,
      reason,
    };
    if (route === "dom-granted") {
      const regranted = ctx.regrantCurrentTarget();
      if (regranted !== "placed") {
        this.ledgerFailedCorrection(`re-grant (${regranted})`, failureDetail);
      }
    } else if (
      this.accessMode === "accessibility" &&
      this.mirrorKeyViewFocus()
    ) {
      // Accessibility mode reasserts the mirror, not the sink ([P10]).
    } else if (!this.parkKeySink()) {
      this.ledgerFailedCorrection("park (no key sink)", failureDetail);
    }
  }

  /**
   * Whether `el` belongs to the engine's universe — the one question the
   * engine asks about a DOM element, and the boundary of its authority.
   *
   * Governed: `<body>` (the empty register), anything inside a deck card,
   * anything carrying an engine identity marker (focusable / responder /
   * state-key — which is how a portaled sheet's fields stay in scope despite
   * having no `[data-card-id]` ancestor), and any key sink.
   *
   * Not governed: a dev overlay, a body-portaled utility menu, a harness
   * fixture, a browser-native surface — DOM the engine neither placed nor
   * models. The engine does not correct focus there and does not claim focus
   * away from there.
   *
   * This is deliberately a membership test, not a taxonomy of element kinds.
   * The predicate the theft gate used to run — "is this a body? a chrome
   * handle? a sink? another card? a sheet?" — was reverse-engineering engine
   * facts from the shape of whatever held `activeElement`. Ownership is the
   * only distinction the engine actually needs.
   */
  governsElement(el: Element): boolean {
    if (typeof document === "undefined") return false;
    if (el === document.body) return true;
    if (el.hasAttribute(KEY_SINK_ATTRIBUTE)) return true;
    if (el.closest("[data-card-id]") !== null) return true;
    return (
      el.closest(
        "[data-tug-focusable], [data-responder-id], [data-tug-state-key]",
      ) !== null
    );
  }

  /**
   * May an activation dispatch claim the keyboard for `targetCardId`?
   * (Spec S03 — the replacement for the retired `focus-theft-gate` module.)
   *
   * The question every programmatic focus path must answer is "would this
   * steal the keyboard from the user?" The gate answered it by classifying
   * `document.activeElement` against a taxonomy of element kinds — nine
   * branches enumerating the configurations in which DOM focus was really the
   * engine's own. Every one of those was an engine fact reverse-engineered
   * from the DOM: "body has focus" meant no grant was outstanding, "the sink
   * is focused" meant the engine held an engine-routed park, "focus is in
   * another card" meant another card held the grant. The engine knows all of
   * that directly, because it placed it.
   *
   * What is left is four rules:
   *
   *  - **Deck state.** A backgrounded app never claims (touching `.focus()`
   *    while another window owns the caret is how reload-steals-typing bugs
   *    happen), and neither does a caller whose model of the active card is
   *    already stale.
   *  - **An empty register is free.** Nothing is being taken.
   *  - **The chrome allowlist** (`data-tug-chrome="non-focus-capturing"`) —
   *    the one genuinely un-modeled DOM input that survives, for chrome that
   *    briefly owns focus between interactions (drag handles, tab buttons).
   *    It shrinks as the engine models more of those gestures.
   *  - **Ownership.** If the engine governs whatever holds the register, the
   *    keyboard is somewhere the engine put it or models, and moving it is
   *    engine business rather than theft — whether that is this card
   *    (idempotent), another card (deliberate navigation), a pane-modal
   *    sheet, or a sink park. Otherwise a real surface outside the engine's
   *    universe holds the keyboard: refuse.
   */
  mayClaimActivationFocus(
    targetCardId: string,
    state: DeckState,
    opts?: { reason?: string },
  ): boolean {
    const refuse = (why: string): false => {
      tugDevLogStore.debug(
        "focus-activation",
        `refusing activation focus claim for ${targetCardId}: ${why}`,
        { targetCardId, why, reason: opts?.reason ?? "(unspecified)" },
      );
      return false;
    };

    if (!state.hasFocus) return refuse("app is backgrounded");
    if (!isFocusDestination(targetCardId, state)) {
      return refuse("target is not the current focus destination");
    }
    // No document: no register, nothing to take.
    if (typeof document === "undefined") return true;

    const active = document.activeElement;
    if (active === null || active === document.body) return true;
    if (
      active.closest('[data-tug-chrome="non-focus-capturing"]') !== null
    ) {
      return true;
    }
    if (this.governsElement(active)) return true;
    return refuse("a surface outside the engine's universe holds the keyboard");
  }

  /**
   * The deck-state half of {@link mayClaimActivationFocus}, callable without
   * an engine — see the module-level `mayClaimActivationFocus` wrapper.
   */
  static deckStatePermits(targetCardId: string, state: DeckState): boolean {
    return state.hasFocus && isFocusDestination(targetCardId, state);
  }

  /**
   * Spend one unit of the reassert budget. Returns whether the
   * correction may proceed. On exhaustion the watchdog STANDS DOWN for
   * the rest of the episode (until a legal pass or a fresh placement
   * resets it) and logs one error naming the fight — a bounded loss of
   * hygiene, traded for the guarantee that two focus enforcers can
   * never lock the app. Keys still route from the engine's target
   * regardless of where `activeElement` is stranded ([P04]).
   */
  private spendReassertBudget(reason: string, fight: string): boolean {
    if (this.reassertBudgetExhausted) return false;
    if (this.reassertEpisodeCount >= FocusManager.REASSERT_BUDGET) {
      this.reassertBudgetExhausted = true;
      tugDevLogStore.error(
        "focus-watchdog",
        `reassert budget exhausted — a peer system is fighting the engine for focus (${fight}); standing down until the next placement (${reason})`,
        { fight, reason, budget: FocusManager.REASSERT_BUDGET },
      );
      return false;
    }
    this.reassertEpisodeCount += 1;
    return true;
  }

  // ---- Keyboard-access mode (deck-global) ----

  /**
   * Set the keyboard-access mode every context's walk reads. A flip
   * re-lands the keyboard for the current key view so the register
   * matches the new mode immediately: to `accessibility`, the mirror
   * grants real DOM focus to the key view ([P10]); back to `standard`,
   * the park resumes and the mirror's added `tabindex` is removed.
   */
  setKeyboardAccessMode(mode: KeyboardAccessMode): void {
    if (this.accessMode === mode) return;
    this.accessMode = mode;
    if (mode === "standard") this.clearMirrorArtifacts();
    this.touch();
    this.activeContext().focusKeyView();
    // Accessibility mode is Class C of the KBF derivation — permanently
    // engaged — so a flip is a mode change and must repaint `data-kbf`.
    this.settleKbfEngagement();
  }

  /** The current keyboard-access mode. */
  keyboardAccessMode(): KeyboardAccessMode {
    return this.accessMode;
  }

  // ---- KBF mode (deck-global, derived) ----

  /**
   * The manual half of the KBF derivation: set by ⌥⇥ and the Keyboard Focus
   * menu item, cleared by a pointerdown anywhere and by the Escape ladder's
   * last rung. Deck-global and survives keyboard-driven card switches ([P05]).
   *
   * Never read directly for "is the mode on?" — that is {@link kbfEngaged}.
   */
  private kbfManuallyEngaged = false;

  /**
   * The last engagement answer, kept purely as a **change detector** for
   * {@link settleKbfEngagement}. Not a cache of the mode: every read of
   * {@link kbfEngaged} recomputes, so a surface closing can never strand the
   * mode on ([P01]).
   */
  private lastKbfEngaged = false;

  /**
   * The last **paint** answer ({@link kbfPainting}), the second change
   * detector: the paint also moves when the keyboard route or the access
   * mode flips under an unchanged engagement (a granted caret standing the
   * marks down inside a still-engaged trap), and those settles must repaint
   * without re-landing the keyboard.
   */
  private lastKbfPainted = false;

  /**
   * Whether keyboard-focus mode is engaged (Spec S01) — the one question the
   * ring gate, the movement stages, and the projection all ask.
   *
   * Derived from four inputs, in this order:
   *  1. **Class C** — accessibility keyboard-access mode is permanently
   *     engaged. Non-negotiable: assistive tech needs every affordance
   *     reachable and every engine stop marked.
   *  2. **Manual** — ⌥⇥ / the menu item ({@link kbfManuallyEngaged}).
   *  3. **Class A** — a trapped mode entry that has not opted out
   *     ({@link FocusContext.hasEngagingTrap}), on the **active** context only:
   *     a trap pushed on a background card is not a surface the user is in.
   *  4. **Class B** — the key card's registration declares `kbfAtRest`.
   *
   * Derived rather than latched is the whole point: a sheet closing pops its
   * mode entry and the answer changes with it, so no path can leave the deck
   * ringed with nothing to ring.
   */
  kbfEngaged(): boolean {
    if (this.accessMode === "accessibility") return true;
    if (this.kbfManuallyEngaged) return true;
    if (this.activeContext().hasEngagingTrap()) return true;
    const componentId = this.keyCardComponentId();
    if (componentId === null) return false;
    return getRegistration(componentId)?.kbfAtRest === true;
  }

  /**
   * Whether the engaged mode is **painting** — the answer `data-kbf` and the
   * ring trigger project. A blinking caret and a focus ring are mutually
   * exclusive: while a caret is live — the route is `dom-granted`, or a bare
   * native control holds a granted caret under the engine route
   * ({@link FocusContext.hasLiveNativeGrant}) — the caret is the focus mark,
   * so the mode's visual vocabulary stands down and comes back with the next
   * park. The mode itself does not move — a seeded sheet is engaged
   * caret-first with no rings, and its first Tab parks and paints.
   *
   * Accessibility mode is exempt, as it is everywhere else: Class C grants
   * every text stop a caret by design, and assistive tech needs the marks up
   * regardless.
   */
  kbfPainting(): boolean {
    if (!this.kbfEngaged()) return false;
    if (this.accessMode === "accessibility") return true;
    const ctx = this.activeContext();
    if (ctx.keyboardRoute() !== "engine-routed") return false;
    // A granted BARE NATIVE control keeps the engine route (dispatch and
    // watchdog legality are built on that), but its caret is live all the
    // same — the paint stands down for it exactly as for a contract grant.
    return !ctx.hasLiveNativeGrant();
  }

  /**
   * Whether the last clear of the manual bit came from a pointerdown. The
   * cycle consumer reads it to skip its resting-focus reclaim: the click that
   * ended the mode places focus itself, and reclaiming would flash the resting
   * caret for a frame before the click's own focus lands.
   */
  private kbfManualClearedByPointer = false;

  /** Whether the manual bit specifically is set (the toggle's own state). */
  kbfManual(): boolean {
    return this.kbfManuallyEngaged;
  }

  /** See {@link kbfManualClearedByPointer}. */
  kbfClearedByPointer(): boolean {
    return this.kbfManualClearedByPointer;
  }

  /** Set the manual engagement bit and settle the mode ([P05]). */
  setKbfManual(value: boolean): void {
    this.kbfManualClearedByPointer = false;
    if (this.kbfManuallyEngaged === value) return;
    this.kbfManuallyEngaged = value;
    this.settleKbfEngagement();
  }

  /**
   * The ⌥⇥ gesture (Spec S04). Returns the resulting manual bit so the caller
   * can seed a ring when it turned on.
   *
   * Not a blind flip. A **live caret** — the keyboard really granted to a text
   * surface (`dom-granted`), or a bare native control holding real focus under
   * the engine route ({@link FocusContext.hasLiveNativeGrant}) — makes ⌥⇥ a
   * request to return to the ring, never to turn the mode off ([P09]). That is
   * the same gesture whether the mode is off (a session card at rest, where it
   * enters the cycle) or already forced on by a surface (a typing descend
   * inside a sheet). With the ring already live, the flip is the ordinary one.
   *
   * "Return to the ring" is honored literally: the stop the caret is on is
   * PARKED ({@link FocusContext.parkAtKeyView}), so the ring appears where the
   * keyboard is and the route moves to `engine-routed` — without which the
   * paint stands down (a caret and a ring never coexist), the gesture shows
   * nothing, and the still-granted route forces every subsequent ⌥⇥ back to
   * `true`: a bit that can never turn off wearing a ring that never appears.
   * A card cycle's `enterModeAtKeyView` runs the same landing; this is the
   * same rule for the modes that have no cycle to enter — a trapped dialog,
   * or a Class-B card at the base mode.
   */
  toggleKbfManual(): boolean {
    const ctx = this.activeContext();
    const caretLive =
      this.keyboardRoute() === "dom-granted" || ctx.hasLiveNativeGrant();
    const next = caretLive ? true : !this.kbfManuallyEngaged;
    this.setKbfManual(next);
    if (next && caretLive) ctx.parkAtKeyView();
    return next;
  }

  /**
   * The pointer half of [P05]: any click clears the manual bit. Cycling is a
   * keyboard mode — the moment the user reaches for the pointer they have left
   * keyboard navigation.
   *
   * Runs synchronously inside the capture-phase pointerdown, ahead of the
   * click's own focus placement, and pops a live focus-cycle itself rather than
   * leaving that to a subscriber's effect: a React round trip would land the
   * pop after the click's focus, leaving the ring painted for a frame over a
   * surface the user has already clicked out of.
   */
  clearKbfManualForPointer(): void {
    if (!this.kbfManuallyEngaged) return;
    this.kbfManuallyEngaged = false;
    this.activeContext().popCycleModeForPointerExit();
    this.settleKbfEngagement();
    // Set AFTER the settle so the consumer's resting-focus reclaim, which runs
    // off the notify, sees it.
    this.kbfManualClearedByPointer = true;
  }

  /**
   * Put the ring somewhere when the mode engages onto a card that has none —
   * the "the mode never points at nothing" half of [P05]. Seeds the current
   * mode's first stop (a scope's commit-home) and lands the keyboard on it.
   *
   * No-op when a key view already exists: an engaged card returning to the
   * foreground keeps the stop it was on, which is the whole point of per-card
   * focus universes. Returns whether a ring was seeded.
   */
  seedKbfRing(): boolean {
    const ctx = this.activeContext();
    if (ctx.keyView() !== null) return false;
    if (ctx.focusFirstInMode() === null) return false;
    ctx.focusKeyView();
    return true;
  }

  /**
   * Settle the deck after any derivation input mutates: notify subscribers,
   * repaint the marks, and — because the keyboard ROUTE is a cache recomputed
   * only inside `realizeTarget`/`focusKeyView` — re-land the keyboard for the
   * current key view (Spec S05). A bare `reproject()` would repaint the marks
   * while leaving the keyboard routed by the old mode's answer, which is
   * exactly how a text stop ends up ringed with a live caret it should not
   * have (or parked with one it should).
   *
   * Gated on the answer actually changing, so the common case — a push that
   * engages nothing new — writes nothing. `focusKeyView` is idempotent on
   * every branch (the grant's already-holds-focus guard, the sink park's
   * already-active guard), so the settle never disturbs a placement that is
   * already true.
   *
   * The shape mirrors {@link setKeyboardAccessMode}, which has settled its own
   * (permanently-engaging) input this way since accessibility mode landed.
   */
  settleKbfEngagement(): void {
    const engaged = this.kbfEngaged();
    const flipped = engaged !== this.lastKbfEngaged;
    this.lastKbfEngaged = engaged;
    // Repaint and re-land the keyboard only on a real flip — the expensive
    // half, and a no-op when the derived answer did not move.
    if (flipped) {
      this.reproject();
      this.activeContext().focusKeyView();
    }
    // The PAINT is its own answer ({@link kbfPainting}) and can move under an
    // unchanged engagement — an access-mode flip over a granted caret is the
    // case no route flip covers (`setRoute` repaints those). Read AFTER the
    // re-land above, which may itself have settled the route. Repaint only:
    // the keyboard is where it belongs, the marks are what moved.
    const painted = this.kbfPainting();
    if (painted !== this.lastKbfPainted) {
      this.lastKbfPainted = painted;
      if (!flipped) this.reproject();
    }
    // But ALWAYS notify. The manual bit is observable state in its own right
    // (`kbfManual()`), and consumers subscribe to it: a card already engaged by
    // its own `kbfAtRest` still has to hear ⌥⇥, or its cycle scope never goes
    // up. Gating the notify on the DERIVED answer is why it didn't.
    this.touch();
  }

  /**
   * The key card's registered `componentId`, resolved through the deck store —
   * the Class-B lookup key. `null` with no key card, no store (the pure-logic
   * tests, a standalone preview), or a card the store does not know.
   */
  private keyCardComponentId(): string | null {
    if (this.keyCardId === null) return null;
    const store = getDeckStore();
    if (store === null) return null;
    const cardId = this.keyCardId;
    return (
      store.getSnapshot().cards.find((c) => c.id === cardId)?.componentId ?? null
    );
  }

  // ---- Ring modality (deck-global) ----

  /**
   * Set whether the focus ring follows pointer-driven key-view changes in
   * addition to keyboard navigation. Repaints immediately by re-projecting the
   * active context (appearance-zone DOM only — no React notify).
   */
  setRingFollowsPointer(value: boolean): void {
    if (this.ringFollowsPointer === value) return;
    this.ringFollowsPointer = value;
    this.activeContext().refreshKeyViewProjection();
  }

  /** Whether the ring currently follows pointer-driven key-view changes. */
  ringFollowsPointerMode(): boolean {
    return this.ringFollowsPointer;
  }

  // ---- Subscription (for useSyncExternalStore consumers, [L02]) ----

  /** Subscribe to manager changes. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Monotonic version for `useSyncExternalStore` snapshots. */
  getVersion(): number {
    return this.version;
  }

  /** Internal: a context mutated — bump the global version and notify all. */
  notifyChange(): void {
    this.touch();
  }

  private touch(): void {
    this.version += 1;
    for (const cb of this.subscribers) {
      cb();
    }
  }

  // ---- Active-context delegations ----
  //
  // The document-listener path and the pure-logic tests call these param-free
  // methods on the coordinator; each services the **key card's** context (the
  // default context when no key card is set). Card-scoped hooks that must target
  // a specific (possibly background) card resolve {@link contextFor} instead.

  registerFocusable(input: FocusableInput): void {
    this.activeContext().registerFocusable(input);
  }
  unregisterFocusable(id: string): void {
    this.activeContext().unregisterFocusable(id);
  }
  setGroupOrder(groups: string[]): void {
    this.activeContext().setGroupOrder(groups);
  }
  setKeyView(id: string | null, keyboard = false): void {
    this.activeContext().setKeyView(id, keyboard);
  }
  refreshKeyViewProjection(keyboard?: boolean): void {
    this.activeContext().refreshKeyViewProjection(keyboard);
  }
  keyView(): string | null {
    return this.activeContext().keyView();
  }
  keyViewIsKeyboard(): boolean {
    return this.activeContext().keyViewIsKeyboard();
  }
  keyViewConsumesTab(): boolean {
    return this.activeContext().keyViewConsumesTab();
  }
  keyViewBehavior(): KeyViewBehavior | null {
    return this.activeContext().keyViewBehavior();
  }
  keyViewCaptures(key: FocusKey): boolean {
    return this.activeContext().keyViewCaptures(key);
  }
  ascend(): boolean {
    return this.activeContext().ascend();
  }
  focusKeyView(): boolean {
    return this.activeContext().focusKeyView();
  }
  /** Whether the key view is a parked text stop — ringed, no caret ([P12]). */
  hasParkedTextStop(): boolean {
    return this.activeContext().hasParkedTextStop();
  }
  /** Grant the caret at a parked text stop and re-land the keyboard ([P12]). */
  grantParkedTextStop(): boolean {
    return this.activeContext().grantParkedTextStop();
  }
  /** Whether a Class A (auto-engaging) trap is on the active context's stack. */
  hasEngagingTrap(): boolean {
    return this.activeContext().hasEngagingTrap();
  }
  pushFocusMode(
    scopeId: string,
    opts: {
      trapped: boolean;
      commitDisposition?: (commit: FocusCommit) => CycleDisposition;
      escapeExits?: boolean;
      onEscapeDismiss?: () => void;
      spaceDismisses?: boolean;
      kbf?: boolean;
    },
  ): void {
    this.activeContext().pushFocusMode(scopeId, opts);
  }
  popFocusMode(
    scopeId: string,
    opts?: { moveDomFocus?: boolean; restoreFirstResponder?: boolean },
  ): void {
    this.activeContext().popFocusMode(scopeId, opts);
  }
  applyCommitDisposition(kind: FocusCommitKind): boolean {
    return this.activeContext().applyCommitDisposition(kind);
  }
  focusFirstInMode(): string | null {
    return this.activeContext().focusFirstInMode();
  }
  /** Land a just-entered mode without advancing through it ([P12], [P09]). */
  enterModeAtKeyView(): string | null {
    return this.activeContext().enterModeAtKeyView();
  }
  currentFocusMode(): string {
    return this.activeContext().currentFocusMode();
  }
  isFocusModePushed(scopeId: string): boolean {
    return this.activeContext().isFocusModePushed(scopeId);
  }
  currentFocusModeTrapped(): boolean {
    return this.activeContext().currentFocusModeTrapped();
  }
  currentModeMember(id: string | null): boolean {
    return this.activeContext().currentModeMember(id);
  }
  currentFocusModeEscapeExits(): boolean {
    return this.activeContext().currentFocusModeEscapeExits();
  }
  currentFocusModeOnEscapeDismiss(): (() => void) | null {
    return this.activeContext().currentFocusModeOnEscapeDismiss();
  }
  currentFocusModeSpaceDismisses(): boolean {
    return this.activeContext().currentFocusModeSpaceDismisses();
  }
  escapeCurrentMode(): boolean {
    return this.activeContext().escapeCurrentMode();
  }
  setDefaultAction(scopeId: string, action: TugAction | null): void {
    this.activeContext().setDefaultAction(scopeId, action);
  }
  resolveDefaultAction(): TugAction | null {
    return this.activeContext().resolveDefaultAction();
  }
  focusNext(): string | null {
    return this.activeContext().focusNext();
  }
  focusPrevious(): string | null {
    return this.activeContext().focusPrevious();
  }
  moveKeyViewLinear(direction: SpatialDirection): string | null {
    return this.activeContext().moveKeyViewLinear(direction);
  }
  moveKeyViewSpatial(direction: SpatialDirection): boolean {
    return this.activeContext().moveKeyViewSpatial(direction);
  }
  walkOrder(): FocusableRecord[] {
    return this.activeContext().walkOrder();
  }

  /**
   * The card's default focus target chosen from its OWN registry: the head of
   * the authored walk order.
   *
   * The walk already encodes everything the DOM selector chain had to learn
   * piecemeal — authored group order, mode participation, rendered-ness,
   * interactivity — so this is the same question with one source of truth. The
   * chain's `data-tug-focus="refuse"` exclusion has no counterpart here:
   * refusal governs what a POINTER gesture may move, while registration is an
   * explicit authoring act that puts a control in the keyboard walk. A button
   * authored into a focus group is a legitimate default target even though
   * clicking it never moves the key view.
   *
   * `skip` is injected so the rule itself stays free of DOM reads.
   *
   * Returns `null` when the card has no context yet, has registered no
   * focusables, or every stop is skipped: a cold boot, or a card whose children
   * have not run their registration effects when the activation settles. The
   * DOM selector chain covers those.
   *
   * This resolves the card's default for the FIRST-RESPONDER settle. It is
   * deliberately not the resolution behind the default focus CLAIM: placing the
   * registry head on activation would give a card a key view merely for coming
   * forward, and the first Tab would then advance past the card's first
   * authored stop instead of landing on it.
   */
  defaultFocusableIdForCard(
    cardId: string,
    skip: (id: string) => boolean,
  ): string | null {
    const ctx = this.contexts.get(cardId);
    if (ctx === undefined) return null;
    for (const record of ctx.walkOrder()) {
      if (!skip(record.id)) return record.id;
    }
    return null;
  }

  /**
   * {@link defaultFocusableIdForCard} resolved against the document: the id plus
   * the element carrying it. A stop with no element in the document is passed
   * over — it registered but has not mounted (or has already unmounted).
   */
  defaultFocusableForCard(
    cardId: string,
  ): { id: string; el: HTMLElement } | null {
    if (typeof document === "undefined") return null;
    let resolved: { id: string; el: HTMLElement } | null = null;
    const id = this.defaultFocusableIdForCard(cardId, (candidateId) => {
      const el = document.querySelector<HTMLElement>(
        `[data-tug-focusable="${cssEscapeId(candidateId)}"]`,
      );
      if (el === null) return true;
      resolved = { id: candidateId, el };
      return false;
    });
    return id === null ? null : resolved;
  }

  registerDefaultRing(node: HTMLElement): void {
    this.activeContext().registerDefaultRing(node);
  }
  unregisterDefaultRing(node: HTMLElement): void {
    this.activeContext().unregisterDefaultRing(node);
  }
}

// ---- React context ----

/**
 * React context holding the singleton FocusManager (deck coordinator) for the
 * canvas subtree. Default `null` (outside any provider). Co-located here so
 * `use-focusable.tsx` and `responder-chain-provider.tsx` import it without a
 * circular dependency -- the same arrangement as `ResponderChainContext`.
 */
export const FocusManagerContext = createContext<FocusManager | null>(null);

// ---- Global handle ----
//
// Last-registration-wins module singleton so framework code outside the React
// tree can reach the engine — the same arrangement as
// `registerResponderChainManager`. Used by the single-channel focus dispatcher
// (`applyBagFocus` in `focus-transfer.ts`) to set the key card on activation and
// re-light the keyboard ring as part of a focus-axis restore. Set by
// `responder-chain-provider` on mount.

let activeFocusManager: FocusManager | null = null;

/** Register the active FocusManager. Called by the provider on mount. */
export function registerFocusManager(manager: FocusManager | null): void {
  activeFocusManager = manager;
}

/** The active FocusManager, or `null` outside a mounted provider. */
export function getFocusManager(): FocusManager | null {
  return activeFocusManager;
}

/**
 * Advance the key view one stop in the current mode's authored order and land
 * DOM focus on it — the whole of what a Tab press does once the precedence
 * ladder above it has declined. Returns whether anything moved, which is what
 * lets the Tab listener decide between swallowing the key and yielding to the
 * browser's native walk.
 *
 * One performer for two doors: the ⇥ / ⇧⇥ listener in
 * `responder-chain-provider`, and the View menu's Next / Previous Keyboard
 * Focus commands, which reach it through `dispatchCommand` like everything
 * else ([L30]). The listener passes its own manager; the menu path takes the
 * registered one.
 */
export function advanceKeyViewFocus(
  manager: FocusManager | null,
  direction: 1 | -1,
): boolean {
  if (manager === null) return false;
  // Engage first ([P07]). Moving the ring is meaningless while the mode that
  // paints it is off, so the shared performer engages rather than each of its
  // doors doing so — the Tab pipeline and the View menu's Next / Previous
  // Keyboard Focus items behave identically, in either mode, by construction.
  if (!manager.kbfEngaged()) manager.setKbfManual(true);
  const moved = direction === 1 ? manager.focusNext() : manager.focusPrevious();
  if (moved === null) return false;
  // The walk is MOVEMENT ([P12]): a text stop Tab lands on is parked — ringed,
  // no caret — until Return or a printable character asks for one.
  manager.place(
    null,
    { kind: "focusable", id: moved },
    { modality: "keyboard", arrival: "movement" },
  );
  return true;
}

/**
 * May an activation dispatch claim the keyboard for `targetCardId`?
 * (Spec S03.) The entry point every programmatic focus path calls — see
 * {@link FocusManager.mayClaimActivationFocus} for the rules.
 *
 * With no engine mounted (a gallery preview, a headless bootstrap) only the
 * deck-state half applies: there is no engine-routed keyboard to protect and
 * no activation channel to strand, so ownership is not a question anyone can
 * ask. This is the honest degradation, not a permissive default.
 */
export function mayClaimActivationFocus(
  targetCardId: string,
  state: DeckState,
  opts?: { reason?: string },
): boolean {
  const manager = activeFocusManager;
  if (manager === null) {
    return FocusManager.deckStatePermits(targetCardId, state);
  }
  return manager.mayClaimActivationFocus(targetCardId, state, opts);
}

/**
 * React context carrying the focus-mode scope id that `useFocusable` callers in
 * the subtree register into. Default `BASE_FOCUS_MODE` (the app shell). A
 * floating surface that pushes a trap provides its scope id here (via
 * `useFocusTrap`), so its focusable contents join the trap's mode and the Tab
 * walk cycles within them — the "a surface's contents register into the mode it
 * pushes" half of [#cfrunloop-model].
 */
export const FocusModeContext = createContext<string>(BASE_FOCUS_MODE);
