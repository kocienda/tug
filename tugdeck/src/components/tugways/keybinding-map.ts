/**
 * keybinding-map.ts — the shape a scoped keybinding takes.
 *
 * This file used to hold the app's global chord map. It does not any more:
 * the shipped chords are default `bindings` on their command's registry
 * entry, and stage 1 resolves the global layer through `keymap-registry.ts`.
 * A chord and a menu item are two doors on one row, which they cannot be
 * while a second table also claims to say what a chord means.
 *
 * What remains is the *shape*, because scoped bindings still use it.
 * `useKeybindings` registrants declare chords that are live only inside a
 * responder or a focus mode, and some of them name verbs that are
 * deliberately outside the command table — the PDF card's scroll keys, the
 * gallery's demo chord. Those dispatch an action directly, so they carry an
 * action rather than a command id.
 *
 * The match rule lives in `chord-format.ts` with the rest of the chord
 * alphabet, so the scoped layer and the global layer agree on what "this
 * chord" means by construction rather than by inspection.
 */

import type { TugAction } from "./action-vocabulary";

// ---- KeyBinding interface ----

/**
 * A single keybinding entry.
 *
 * `key` is a US-layout KeyboardEvent.code name, e.g. "Backquote", "KeyN",
 * matched by `effectiveCode` in `chord-format.ts`: a letter names the key
 * that types it on the user's layout, anything else a physical key.
 * Modifier flags default to false when absent.
 */
export interface KeyBinding {
  /** US-layout KeyboardEvent.code name; a letter follows the user's layout. */
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** TugAction name to dispatch when the binding matches */
  action: TugAction;
  /**
   * The registry command this chord invokes, when it invokes one.
   *
   * A scoped binding on a real command names the command, and the whole
   * dispatch — routing, payload, validity — is read from its registry entry
   * rather than from this object. A scoped binding on a verb that is
   * deliberately outside the table (the PDF card's scroll keys, the gallery's
   * demo chord) leaves this absent and dispatches `action` directly.
   */
  commandId?: string;
  /**
   * When true, the pipeline calls preventDefault on the event when this
   * binding matches, before dispatching to the responder chain. This allows
   * browser-default behaviors (e.g. Cmd+A select-all) to be suppressed even
   * when no responder handles the action.
   *
   * [D06] Phase 5a: used for the Cmd+A selectAll binding so the browser's
   * native select-all is always suppressed when the keybinding matches.
   */
  preventDefaultOnMatch?: boolean;
  /**
   * Static payload copied onto the dispatched ActionEvent's `value`
   * field when this binding matches. Phase A3 / R4 introduced this
   * for the ⌘1..⌘9 → `jumpToTab` family, where the binding needs to
   * carry the 1-based tab index into the dispatch. Omit for actions
   * whose handlers take no payload.
   *
   * The field is typed `unknown` to match `ActionEvent.value`, which
   * itself is untyped by design (see action-vocabulary.ts for the
   * "middle ground" rationale). Handlers narrow at the dispatch site
   * via `typeof` or structural guards, same as any other action.
   */
  value?: unknown;
  /**
   * Routing for this binding's dispatch.
   *
   *   - `"first-responder"` (default) — existing semantics; the
   *     capture-phase listener calls
   *     `sendToFirstResponderForContinuation`, which walks up from the
   *     current first responder. Use for shortcuts whose target
   *     depends on which specific element the user is inside (clipboard,
   *     undo, tab navigation, etc.).
   *
   *   - `"key-card"` — dispatches to the `kind: "card-content"`
   *     responder inside the *active card* (regardless of which
   *     element inside the card is focused). Use for shortcuts that
   *     belong to "whichever card the user is currently in" — e.g.
   *     ⌘K focus-prompt. Each card type declares its own handlers by
   *     registering a `card-content` responder in its body; the chain
   *     walks UP from there, so unhandled actions fall through to the
   *     card-level responder and above as usual.
   */
  scope?: "first-responder" | "key-card";
}

