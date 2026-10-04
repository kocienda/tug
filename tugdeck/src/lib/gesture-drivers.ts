/**
 * The settle gestures, driven through one door.
 *
 * Every gesture that arms a settle — the warm flip, fold and unfold, a
 * pane's close, showing the rails, a column split and a workspace switch —
 * is named here once, and resolved to the real entry point a user's
 * gesture reaches: the control-frame dispatch, the call every menu item
 * and control makes, or the deck store's `handlePaneClosed`, the call a
 * pane's close button makes. `window.tugdeck.lab.drive` exposes
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
      const slot = args.slot;
      if (slot === undefined) {
        return { error: `split: missing argument "slot"` };
      }
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
        return { error: `split: "slot" must be a non-negative integer` };
      }
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
    default:
      return {
        error: `unknown gesture "${gesture}" (expected one of ${SETTLE_GESTURES.join(", ")})`,
      };
  }
}

/**
 * Resolve a gesture and perform it through the door a user's gesture
 * reaches, under the hold a real click puts on it. Returns `{ ok: true }`
 * once the call was made, or the resolution's error; a close with no deck
 * store registered, or naming a pane the deck does not hold, is an error
 * too, since nothing was driven ([L31]: a refusal the caller can read).
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
): { ok: true } | { error: string } {
  const resolved = resolveGesture(gesture, args);
  if ("error" in resolved) return resolved;
  if (resolved.kind === "close") {
    const store = getDeckStore();
    if (!store) return { error: "close: no deck store is registered" };
    const { paneId } = resolved;
    if (!store.getSnapshot().panes.some((pane) => pane.id === paneId)) {
      return { error: `close: no pane "${paneId}" on the deck` };
    }
    scope.open("pointer");
    store.handlePaneClosed(paneId);
    return { ok: true };
  }
  scope.open("pointer");
  dispatch({ ...resolved.payload, action: resolved.action });
  return { ok: true };
}
