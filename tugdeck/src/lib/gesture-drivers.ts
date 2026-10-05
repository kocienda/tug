/**
 * The settle gestures, driven through one door.
 *
 * Every gesture that arms a settle — the warm flip, fold and unfold, a
 * pane's close, showing the rails, a column split, a workspace switch, a
 * card sent to a slot (⌘n), the band sent to a slot (⌃⌘n), bullseye, one
 * sidebar hidden or shown, resize-to-fit, a card appearing, and a flow
 * slide that is guaranteed to travel — is named here once, and resolved to
 * the real entry point a user's gesture reaches: the control-frame
 * dispatch, the call every menu item, chord and control makes, or the deck
 * store's `handlePaneClosed`, the call a pane's close button makes. Where a
 * menu handler first resolves a selection or a first responder (⌘n's
 * layout selection, bullseye's focused pane), the gesture drives the
 * pane- or card-addressed sibling that handler dispatches once it has
 * resolved, so the driver is not order-sensitive and still drives the
 * user's path. `window.tugdeck.lab.drive` exposes
 * `driveGesture`, so the `tugtool deck motion settle` verb on a release deck
 * and the app-tests in the harness drive exactly the same code, and neither
 * is a parallel path.
 *
 * The close is the reason this exists beside `lab.dispatch`: `close-pane`
 * takes its pane from the dispatch target, not a payload, so no dispatch
 * can name the pane to close.
 *
 * `resolveGesture` is pure — it validates the arguments and returns what
 * to call — so the table is testable without a DOM or a deck.
 */

import { getDeckStore } from "./deck-store-registry";
import { gestureScope, type GestureScope } from "./gesture-scope";

/** The gestures, in the order the settle verb lists them. */
export const SETTLE_GESTURES = [
  "flip",
  "fold",
  "unfold",
  "close",
  "rails",
  "split",
  "switch",
  "slot",
  "go",
  "bullseye",
  "sidebar",
  "fit",
  "appear",
  "slide",
] as const;

export type SettleGesture = (typeof SETTLE_GESTURES)[number];

export type ResolvedGesture =
  | { kind: "action"; action: string; payload: Record<string, unknown> }
  | { kind: "close"; paneId: string }
  | { error: string };

function stringArg(
  gesture: string,
  args: Record<string, unknown>,
  key: string,
): string | { error: string } {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return { error: `${gesture}: missing argument "${key}"` };
  }
  return value;
}

function slotArg(
  gesture: string,
  args: Record<string, unknown>,
): number | { error: string } {
  const slot = args.slot;
  if (slot === undefined) {
    return { error: `${gesture}: missing argument "slot"` };
  }
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
    return { error: `${gesture}: "slot" must be a non-negative integer` };
  }
  return slot;
}

/**
 * Resolve a gesture and its arguments to the call that performs it, or to
 * an error naming what is missing or wrong.
 *
 * - `flip` needs `card`: `focus-session-card { cardId }`.
 * - `fold` and `unfold` need `card`: `set-card-folded { cardId, folded }`.
 * - `close` needs `pane`: the deck store's `handlePaneClosed(paneId)`.
 * - `rails` needs nothing: `toggle-sidebars {}`.
 * - `split` needs `slot` (a non-negative integer) and takes `mode`
 *   (`"split"` or `"stack"`, default `"split"`): `set-column-mode`.
 * - `switch` needs `space`: `activate-space { spaceId }`.
 * - `slot` needs `card` and `slot`: `assign-slot { cardId, slot }`, the ⌘n
 *   door, which seats the card at the bottom of a split column ([D194]).
 * - `go` needs `slot` (0-based): `go-to-slot { value: slot + 1 }`, the ⌃⌘n
 *   door, whose value is the 1-based slot number.
 * - `bullseye` needs `pane`: `set-bullseye { paneId }`, which toggles.
 * - `sidebar` needs `component` and `open` (a boolean):
 *   `set-sidebar-open { componentId, open }`, the Layout card's row.
 * - `fit` needs nothing: `resize-sidebars-to-fit {}`.
 * - `appear` needs nothing: `show-card { component: "session" }`, a picker
 *   card arriving.
 * - `slide` needs `card`: `focus-session-card { cardId }`, as `flip` — the
 *   driver refuses it after the fact when the strip did not travel.
 */
export function resolveGesture(
  gesture: string,
  args: Record<string, unknown> = {},
): ResolvedGesture {
  switch (gesture) {
    case "flip": {
      const cardId = stringArg(gesture, args, "card");
      if (typeof cardId !== "string") return cardId;
      return { kind: "action", action: "focus-session-card", payload: { cardId } };
    }
    case "fold":
    case "unfold": {
      const cardId = stringArg(gesture, args, "card");
      if (typeof cardId !== "string") return cardId;
      return {
        kind: "action",
        action: "set-card-folded",
        payload: { cardId, folded: gesture === "fold" },
      };
    }
    case "close": {
      const paneId = stringArg(gesture, args, "pane");
      if (typeof paneId !== "string") return paneId;
      return { kind: "close", paneId };
    }
    case "rails":
      return { kind: "action", action: "toggle-sidebars", payload: {} };
    case "split": {
      const slot = slotArg(gesture, args);
      if (typeof slot !== "number") return slot;
      const mode = args.mode ?? "split";
      if (mode !== "split" && mode !== "stack") {
        return { error: `split: "mode" must be "split" or "stack"` };
      }
      return { kind: "action", action: "set-column-mode", payload: { slot, mode } };
    }
    case "switch": {
      const spaceId = stringArg(gesture, args, "space");
      if (typeof spaceId !== "string") return spaceId;
      return { kind: "action", action: "activate-space", payload: { spaceId } };
    }
    case "slot": {
      const cardId = stringArg(gesture, args, "card");
      if (typeof cardId !== "string") return cardId;
      const slot = slotArg(gesture, args);
      if (typeof slot !== "number") return slot;
      return { kind: "action", action: "assign-slot", payload: { cardId, slot } };
    }
    case "go": {
      const slot = slotArg(gesture, args);
      if (typeof slot !== "number") return slot;
      return { kind: "action", action: "go-to-slot", payload: { value: slot + 1 } };
    }
    case "bullseye": {
      const paneId = stringArg(gesture, args, "pane");
      if (typeof paneId !== "string") return paneId;
      return { kind: "action", action: "set-bullseye", payload: { paneId } };
    }
    case "sidebar": {
      const componentId = stringArg(gesture, args, "component");
      if (typeof componentId !== "string") return componentId;
      const open = args.open;
      if (open === undefined) {
        return { error: `sidebar: missing argument "open"` };
      }
      if (typeof open !== "boolean") {
        return { error: `sidebar: "open" must be a boolean` };
      }
      return {
        kind: "action",
        action: "set-sidebar-open",
        payload: { componentId, open },
      };
    }
    case "fit":
      return { kind: "action", action: "resize-sidebars-to-fit", payload: {} };
    case "appear":
      return { kind: "action", action: "show-card", payload: { component: "session" } };
    case "slide": {
      const cardId = stringArg(gesture, args, "card");
      if (typeof cardId !== "string") return cardId;
      return { kind: "action", action: "focus-session-card", payload: { cardId } };
    }
    default:
      return {
        error: `unknown gesture "${gesture}" (expected one of ${SETTLE_GESTURES.join(", ")})`,
      };
  }
}

/**
 * Resolve a gesture and perform it through the door a user's gesture
 * reaches, under the hold a real click puts on it. Returns `{ ok: true }`
 * once the call was made, or the resolution's error; a close or bullseye
 * naming a pane the deck does not hold, or a `slot` naming a card no pane
 * holds, is an error too, since nothing was driven ([L31]: a refusal the
 * caller can read). Those three, and `appear` and `slide`, need the deck
 * store, and refuse without one.
 *
 * `appear` returns the arriving pane — the deck's `activePaneId` after the
 * dispatch, which `addCard` sets synchronously — so a caller can close it.
 * `slide` reads the strip's `flowOffset` before and after, and refuses a
 * slide that moved nothing: a focus of a card already in the band is a
 * `flip`, and a reading of it as a slide would be unfalsifiable.
 *
 * A click opens a `pointer` scope at its pointerdown, ahead of any handler,
 * and the scope releases itself past the next paint
 * (`installGestureScope`). A driven gesture runs in an evaluate task with no
 * pointer event in it, so it opens the same scope itself, after the
 * gesture resolved and before the call: every non-deck store is held for
 * the gesture's commit exactly as it is for the user's, and what the
 * harness and the settle verb measure is the gesture the user makes. The
 * scope closes the way a click's does, by its own release.
 *
 * `dispatch` is the control-frame door, handed in by `main.tsx` — the one
 * module allowed to import `dispatchAction` for a replayed frame — so this
 * module adds no second importer of it (`one-front-door.test.ts`).
 * `scope` is the singleton outside unit tests, which have no paint to wait on.
 */
export function driveGesture(
  dispatch: (frame: { action: string } & Record<string, unknown>) => void,
  gesture: string,
  args: Record<string, unknown> = {},
  scope: Pick<GestureScope, "open"> = gestureScope,
): { ok: true; paneId?: string } | { error: string } {
  const resolved = resolveGesture(gesture, args);
  if ("error" in resolved) return resolved;
  const needsStore =
    resolved.kind === "close" ||
    gesture === "slot" ||
    gesture === "bullseye" ||
    gesture === "appear" ||
    gesture === "slide";
  const store = needsStore ? getDeckStore() : null;
  if (needsStore && !store) {
    return { error: `${gesture}: no deck store is registered` };
  }
  if (resolved.kind === "close") {
    const { paneId } = resolved;
    if (!store!.getSnapshot().panes.some((pane) => pane.id === paneId)) {
      return { error: `close: no pane "${paneId}" on the deck` };
    }
    scope.open("pointer");
    store!.handlePaneClosed(paneId);
    return { ok: true };
  }
  if (gesture === "slot") {
    const cardId = resolved.payload.cardId as string;
    if (!store!.getSnapshot().panes.some((pane) => pane.cardIds.includes(cardId))) {
      return { error: `slot: no pane holds card "${cardId}"` };
    }
  }
  if (gesture === "bullseye") {
    const paneId = resolved.payload.paneId as string;
    if (!store!.getSnapshot().panes.some((pane) => pane.id === paneId)) {
      return { error: `bullseye: no pane "${paneId}" on the deck` };
    }
  }
  const offsetBefore = gesture === "slide" ? (store!.getSnapshot().flowOffset ?? 0) : 0;
  scope.open("pointer");
  dispatch({ ...resolved.payload, action: resolved.action });
  if (gesture === "appear") {
    return { ok: true, paneId: store!.getSnapshot().activePaneId };
  }
  if (gesture === "slide") {
    if ((store!.getSnapshot().flowOffset ?? 0) === offsetBefore) {
      const cardId = resolved.payload.cardId as string;
      return {
        error: `slide: the strip did not travel — ${cardId} was already in the band`,
      };
    }
  }
  return { ok: true };
}
