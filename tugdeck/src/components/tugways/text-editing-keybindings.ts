/**
 * text-editing-keybindings.ts -- Substrate-local registry of the
 * gap-fill text-editing keybindings.
 *
 * Scope: this registry is consumed by the text-editing substrates
 * themselves (`useTextInputResponder` for native `<input>` /
 * `<textarea>`; the CM6 keymap layer for `tug-text-editor`). It is
 * NOT consumed by the global capture-phase pipeline. Movement and
 * deletion only ever target the focused text input, so the chain
 * abstraction adds nothing here — see [DM01] in
 * `tugplan-text-editing-keybindings.md` for the rationale, and
 * `command-registry.ts` for the cross-substrate semantics that *do*
 * belong on the global pipeline (Cmd-A, Cmd-W, Cmd-T, Cmd-1..9, etc.),
 * where they are default `bindings` on their command's entry.
 *
 * Why a separate module: the registry is the data layer a future
 * settings UI for keybinding remap will read and write. Per [DM06],
 * the export shape (`let EDITING_KEYBINDINGS` plus a
 * `setEditingKeybindings(next)` setter) is laid out so a future plan
 * can ship the dialog as a mechanical edit. The substrate hooks read
 * the registry at keystroke time (via `matchEditingKeybinding`),
 * never at mount time, so a runtime remap takes effect on the next
 * keystroke — mirrors [L07]'s "read config at call time."
 *
 * What this registers: only the four "gap" bindings that fall through
 * AppKit's field editor (for native inputs) and CodeMirror's
 * `defaultKeymap` (for the editor) today. Per [DM02], the
 * platform-handled bindings (Ctrl-A/E/F/B/P/N/D/H/K/T, Option-Delete)
 * are NOT in this registry — adding dead names for already-handled
 * keystrokes would create reviewer confusion without earning
 * anything. The audit table in
 * `tugplan-text-editing-keybindings.md` is the documentation; this
 * registry is for live bindings only.
 *
 * Shape: `EditingKeybinding` mirrors `Chord` in
 * `command-registry.ts` but without the display label, and without the
 * `preventDefault` / payload / routing a command binding carries (none
 * of which apply to substrate-local editing dispatch). It adds `shiftExtends`: when true, the matcher accepts
 * the keystroke regardless of `event.shiftKey`, and the substrate
 * handler reads `shiftKey` separately to decide motion-vs-selection
 * per [DM05]. Without `shiftExtends`, the matcher demands an exact
 * shift match.
 */

import type { TugAction } from "./action-vocabulary";
import { TUG_ACTIONS } from "./action-vocabulary";
import { effectiveCode } from "./chord-format";

// ---- EditingKeybinding interface ----

/**
 * A single text-editing keybinding entry.
 *
 * `key` is a US-layout `KeyboardEvent.code` name, as on `Chord` in
 * `command-registry.ts`, and is matched the same way, by
 * `effectiveCode` in `chord-format.ts`: a letter names the key that
 * types it on the user's layout. Modifier flags default to false
 * when absent.
 *
 * `shiftExtends` is the only field new to this module: when true,
 * the matcher accepts the keystroke regardless of `event.shiftKey`,
 * and the substrate handler reads `shiftKey` separately to decide
 * motion-vs-selection per [DM05]. Set on `MOVE_*` entries so the
 * "Shift extends selection" semantic is encoded in the registry,
 * not hard-coded per handler.
 */
export interface EditingKeybinding {
  /** US-layout KeyboardEvent.code name; a letter follows the user's layout. */
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** TugAction name to dispatch when the binding matches. */
  action: TugAction;
  /**
   * When true, the matcher accepts the keystroke regardless of
   * `event.shiftKey`. The substrate handler reads `shiftKey`
   * separately to decide whether to extend the selection (Shift
   * held) or collapse it (Shift not held). Per [DM05].
   *
   * When false (or absent), `event.shiftKey` must equal `shift ??
   * false` exactly for the binding to match — the same exact-shift
   * semantics `chordMatchesEvent` uses.
   */
  shiftExtends?: boolean;
}

// ---- Default registry ----

/**
 * The default text-editing keybinding registry.
 *
 * Mutable per [DM06] so a future settings UI can replace it via
 * `setEditingKeybindings(next)`. The substrate hooks read this
 * binding at keystroke time, not at mount time, so a runtime remap
 * takes effect on the next keystroke. The reference is
 * intentionally re-bindable (the `let` plus the setter); tests
 * that need to override and reset can capture the current value
 * and restore it without rebuilding consumers.
 */
let EDITING_KEYBINDINGS: EditingKeybinding[] = [
  // Ctrl-U: erase backward to start of line.
  { key: "KeyU", ctrl: true, action: TUG_ACTIONS.DELETE_TO_LINE_START },
  // Ctrl-W: erase the previous word.
  { key: "KeyW", ctrl: true, action: TUG_ACTIONS.DELETE_WORD_BACKWARD },
  // Alt-F (Option-F): move forward one word; Shift extends selection.
  { key: "KeyF", alt: true, action: TUG_ACTIONS.MOVE_WORD_FORWARD, shiftExtends: true },
  // Alt-B (Option-B): move backward one word; Shift extends selection.
  { key: "KeyB", alt: true, action: TUG_ACTIONS.MOVE_WORD_BACKWARD, shiftExtends: true },
];

/**
 * Read the current registry. Substrate hooks call this from the
 * keystroke listener so a runtime remap (via
 * `setEditingKeybindings`) takes effect immediately. Returned
 * array is the live reference; callers must not mutate it in
 * place.
 */
export function getEditingKeybindings(): readonly EditingKeybinding[] {
  return EDITING_KEYBINDINGS;
}

/**
 * Replace the active registry. Intended for the future settings
 * UI per [DM06]; tests can also use it to install a fixture
 * registry (with a paired restoration in `afterEach`).
 *
 * The function takes a fresh array rather than a mutator so the
 * old reference stays stable for any consumer that captured it
 * before the swap.
 */
export function setEditingKeybindings(next: EditingKeybinding[]): void {
  EDITING_KEYBINDINGS = next;
}

// ---- matchEditingKeybinding ----

/**
 * Match a `KeyboardEvent` against the active text-editing keybinding
 * registry.
 *
 * Returns the matched `EditingKeybinding` so the caller can read
 * `action` and `shiftExtends`, or `null` if no binding matches.
 *
 * The key is compared by the event's `effectiveCode`, the one rule
 * every chord is matched by, so ⌃W is the key that types W on the
 * user's layout. Modifier matching mirrors `chordMatchesEvent` in
 * `chord-format.ts` for `ctrl` / `meta` / `alt` (exact match; absent
 * flag means false). The shift comparison branches on
 * `shiftExtends`:
 *
 *   - `shiftExtends: true` — the matcher accepts the keystroke
 *     regardless of `event.shiftKey`. The substrate handler reads
 *     `shiftKey` separately to decide motion-vs-selection per
 *     [DM05].
 *
 *   - `shiftExtends: false | undefined` — `event.shiftKey` must
 *     equal `binding.shift ?? false` exactly, same as
 *     `chordMatchesEvent`.
 *
 * The function is pure and re-reads the registry on every call so
 * a `setEditingKeybindings` swap takes effect on the next
 * keystroke without any caller refresh.
 */
export function matchEditingKeybinding(event: KeyboardEvent): EditingKeybinding | null {
  const code = effectiveCode(event);
  for (const binding of EDITING_KEYBINDINGS) {
    if (code !== binding.key) continue;
    if (!!event.ctrlKey !== (binding.ctrl ?? false)) continue;
    if (!!event.metaKey !== (binding.meta ?? false)) continue;
    if (!!event.altKey !== (binding.alt ?? false)) continue;
    if (!binding.shiftExtends) {
      if (!!event.shiftKey !== (binding.shift ?? false)) continue;
    }
    return binding;
  }
  return null;
}
