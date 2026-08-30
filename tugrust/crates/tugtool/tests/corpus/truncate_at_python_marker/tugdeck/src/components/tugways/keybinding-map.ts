/**
 * keybinding-map.ts -- Static keybinding map for the four-stage key pipeline.
 *
 * Maps key combinations to TugAction names. Stage 1 of the key
 * pipeline (capture-phase listener) consults this map.
 *
 * Format: { key: KeyboardEvent.code, ctrl?, meta?, shift?, alt?, action, preventDefaultOnMatch? }
 *
 * [D04] Minimal static keybinding map for Phase 3
 * [D06] preventDefaultOnMatch added in Phase 5a for Cmd+A scoping ()
 *,  */

import type { TugAction } from "./action-vocabulary";
import { TUG_ACTIONS } from "./action-vocabulary";

// ---- KeyBinding interface ----

/**
 * A single keybinding entry.
 *
 * `key` uses the KeyboardEvent.code value (layout-independent), e.g.
 * "Backquote", "KeyN". Modifier flags default to false when absent.
 */
export interface KeyBinding {
  /** KeyboardEvent.code (layout-independent key identifier) */
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** TugAction name to dispatch when the binding matches */
  action: TugAction;
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

// ---- Keybindings ----

/**
 * Static keybinding map.
 *
 * Extensible: later phases add entries here without changing pipeline logic.
 *
 * Phase A3 / R4 added the macOS-standard shortcut set. Every entry
 * dispatches a typed action through the responder chain; the walk
 * lands on whatever responder registered a handler for that action
 * (editor for undo, card for close/tab nav, canvas for show-settings
 * and add-card-to-active-pane, any of the floating surfaces for
 * cancel-dialog). There is no per-component keyboard wiring — adding
 * a new shortcut is one entry here and (if needed) one handler on
 * the responder that owns the semantic.
 *
 * Shortcuts that currently dispatch to stub handlers (⌘,) still route
 * through the chain so the keystroke has a single code path from the
 * moment the handler grows real behavior.
 *
 *  * | Ctrl+`           | cycle-card             | stage 1 (global shortcut)       |
 * | Cmd+A            | select-all             | stage 1 + preventDefaultOnMatch |
 * | Cmd+X            | cut                    | stage 1 + preventDefaultOnMatch |
 * | Cmd+C            | copy                   | stage 1 + preventDefaultOnMatch |
 * | Cmd+V            | paste                  | stage 1 + preventDefaultOnMatch |
 * | Cmd+Z            | undo                   | stage 1 + preventDefaultOnMatch |
 * | Shift+Cmd+Z      | redo                   | stage 1 + preventDefaultOnMatch |
 * | Cmd+W            | close                  | stage 1 (card close)            |
 * | Cmd+T            | add-card-to-active-pane | stage 1 (canvas)                |
 * | Cmd+,            | show-settings          | stage 1 (canvas stub)           |
 * | Cmd+.            | cancel-dialog          | stage 1 (floating surfaces)     |
 * | Cmd+F            | find                   | stage 1 + preventDefaultOnMatch |
 * | Shift+Cmd+[      | previous-tab           | stage 1 (card, wraps)           |
 * | Shift+Cmd+]      | next-tab               | stage 1 (card, wraps)           |
 * | Cmd+1..Cmd+9     | move-to-slot           | stage 1 + value: 1..9 payload   |
 */
export const KEYBINDINGS: KeyBinding[] = [
  { key: "Backquote", ctrl: true, action: TUG_ACTIONS.CYCLE_CARD },
  { key: "KeyA", meta: true, action: TUG_ACTIONS.SELECT_ALL, preventDefaultOnMatch: true },
  // Clipboard shortcuts route through the responder chain so the first
  // responder (e.g. an editor's registered action) does the work. The
  // browser's native clipboard handling is suppressed via
  // preventDefaultOnMatch so a single code path (the responder) owns
  // the semantics — including atom-aware HTML preservation.
  { key: "KeyX", meta: true, action: TUG_ACTIONS.CUT, preventDefaultOnMatch: true },
  { key: "KeyC", meta: true, action: TUG_ACTIONS.COPY, preventDefaultOnMatch: true },
  // Copy variant. ⌥⇧⌘C strips Markdown from the selection to plain text.
  // The exact-modifier match in `keyBindingMatchesEvent` keeps it distinct
  // from bare ⌘C, so this variant carries the extra ⌥⇧. In Tug.app the Swift
  // Edit menu owns the chord (AppKit swallows it at the menu bar and
  // round-trips a control frame); this entry serves browser-only dev where no
  // Swift menu is present.
  { key: "KeyC", meta: true, shift: true, alt: true, action: TUG_ACTIONS.COPY_AS_PLAIN_TEXT, preventDefaultOnMatch: true },
  { key: "KeyV", meta: true, action: TUG_ACTIONS.PASTE, preventDefaultOnMatch: true },
  // Paste variants. ⌥⌘V wraps the clipboard as a Markdown blockquote;
  // ⌥⇧⌘V strips Markdown to plain text (moved off ⇧⌘V to pair with the
  // ⌥⇧⌘C copy variant). The exact-modifier match in `keyBindingMatchesEvent`
  // keeps these distinct from bare ⌘V. In Tug.app the Swift Edit menu owns
  // these chords (AppKit swallows them at the menu bar and round-trips a
  // control frame); these entries serve browser-only dev where no Swift menu
  // is present.
  { key: "KeyV", meta: true, alt: true, action: TUG_ACTIONS.PASTE_AS_QUOTE, preventDefaultOnMatch: true },
  { key: "KeyV", meta: true, shift: true, alt: true, action: TUG_ACTIONS.PASTE_AS_PLAIN_TEXT, preventDefaultOnMatch: true },
  // Undo / redo do NOT use preventDefaultOnMatch. Native <input> and
  // <textarea> elements rely on the browser's built-in undo stack,
  // which no JavaScript API can trigger programmatically. These
  // components do not register undo/redo handlers, so the dispatch
  // returns handled=false, preventDefault is skipped, and the
  // browser's native Cmd+Z runs. ContentEditable responders (e.g.
  // tug-prompt-input) register their own handlers; when handled, the
  // dispatch branch calls preventDefault so the engine's execCommand
  // is the single source of truth.
  { key: "KeyZ", meta: true, action: TUG_ACTIONS.UNDO },
  { key: "KeyZ", meta: true, shift: true, action: TUG_ACTIONS.REDO },
  // Card / canvas / dialog shortcuts. Most do NOT set
  // preventDefaultOnMatch: either the key has no browser default we
  // care about (⌘W in a WebView is app-level), or the default is
  // already suppressed upstream (⌘T via the Swift menu), or there is
  // no conflicting default at all (⌘, and ⌘. inside a WebView run
  // without a browser UI to collide with). ⌘F is the exception — see
  // its entry below.
  { key: "KeyW", meta: true, action: TUG_ACTIONS.CLOSE },
  // ⌥⌘W — Close All Card Tabs (every tab in the focused multi-card pane).
  // App-level in the WebView; the Swift File menu drives it natively and
  // gates enablement on a multi-card focused pane. This entry serves
  // browser-only dev where no Swift menu is present.
  { key: "KeyW", meta: true, alt: true, action: TUG_ACTIONS.CLOSE_ALL },
  { key: "KeyT", meta: true, action: TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE },
  // Focus the key card's prompt input. `scope: "key-card"` routes the
  // dispatch to the `card-content` responder inside the active card;
  // each card type that has a prompt (dev, future) registers a
  // FOCUS_PROMPT handler there. Non-prompt cards (gallery, git) don't
  // register; the dispatch is a silent no-op and
  // `preventDefaultOnMatch` suppresses the macOS beep regardless.
  {
    key: "KeyK",
    meta: true,
    action: TUG_ACTIONS.FOCUS_PROMPT,
    scope: "key-card",
    preventDefaultOnMatch: true,
  },
  { key: "Comma", meta: true, action: TUG_ACTIONS.SHOW_SETTINGS },
  // ⌘L moves focus into the Lens (opening it if hidden); ⌥⌘L toggles the
  // rail's visibility (browser-dev parity with the Swift "Show Lens" menu).
  { key: "KeyL", meta: true, action: TUG_ACTIONS.FOCUS_LENS, preventDefaultOnMatch: true },
  { key: "KeyL", meta: true, alt: true, action: TUG_ACTIONS.TOGGLE_LENS, preventDefaultOnMatch: true },
  { key: "Period", meta: true, action: TUG_ACTIONS.CANCEL_DIALOG },
  // Escape routes to the same chain action as ⌘. so floating UI
  // (popovers, alerts, sheets) dismisses via its existing
  // CANCEL_DIALOG handlers, AND — when nothing dialog-like is in the
  // chain — a card-level CANCEL_DIALOG handler (e.g. session-card.tsx's
  // card-content responder) can interrupt an in-flight turn. The
  // chain's "first responder up" walk gives the natural priority:
  // visible popover dismisses first, drag cancels next (via the
  // separate document-level Escape listener in card-drag-coordinator),
  // in-flight interrupt last. No `preventDefaultOnMatch`: when no
  // responder claims the action the event continues to bubble so
  // bubble-phase consumers (e.g. CodeMirror's autocomplete dismiss)
  // still see it.
  { key: "Escape", action: TUG_ACTIONS.CANCEL_DIALOG },
  // ⌘F — open the first responder's find bar. Every card that can be
  // searched (session transcript, Text card, code view) registers a FIND
  // handler; `host-menu-state` derives Edit ▸ Find…'s enablement from that
  // same chain validation. `preventDefaultOnMatch` is app-wide and matters
  // only in browser dev: it keeps the browser's own find UI from opening
  // over the deck. The consequence is that in dev, ⌘F on a card with no
  // find responder is silently swallowed rather than reaching the browser —
  // intended, since a native find panel over a virtualized transcript
  // searches only the rendered slice. In Tug.app the flag is inert; AppKit
  // has already consumed the chord at the menu bar.
  { key: "KeyF", meta: true, action: TUG_ACTIONS.FIND, preventDefaultOnMatch: true },
  // ⌘G / ⇧⌘G — find next / find previous within the active find session.
  // Routes through the chain; the responder that owns the find session
  // (currently `FileBlock`) handles. Empty / invalid query is a silent
  // no-op on the handler side. `preventDefaultOnMatch` is not set:
  // browsers have no default meaning for ⌘G inside a WKWebView.
  { key: "KeyG", meta: true, action: TUG_ACTIONS.FIND_NEXT },
  { key: "KeyG", meta: true, shift: true, action: TUG_ACTIONS.FIND_PREVIOUS },
  // ⌘S — flush the first responder's pending edits to disk now (live
  // autosave makes this "write immediately + checkpoint", never a
  // dirty-state gate). `preventDefaultOnMatch` suppresses WebKit's
  // save-page default so the chord is inert when nothing handles it.
  { key: "KeyS", meta: true, action: TUG_ACTIONS.SAVE, preventDefaultOnMatch: true },
  // Tab navigation: macOS convention (Safari, Terminal) uses
  // ⇧⌘[ / ⇧⌘] for previous / next tab with wrap-around. Routes to
  // TugPane's existing previous-tab / next-tab handlers, which already
  // wrap via `(idx ± 1 + n) % n`.
  { key: "BracketLeft", meta: true, shift: true, action: TUG_ACTIONS.PREVIOUS_TAB },
  { key: "BracketRight", meta: true, shift: true, action: TUG_ACTIONS.NEXT_TAB },
  // Move the selected card to a numbered slot (⌘1..⌘9). Each binding
  // carries its 1-based slot number on `value`; the capture-phase
  // pipeline copies that onto the dispatched ActionEvent, and
  // DeckCanvas's `move-to-slot` handler resolves the selection and the
  // range. The chords track the Lens's Layouts section: only the
  // numbers the current arrangement actually has are live, and the
  // rest do nothing.
  //
  // All nine digits are bound even though six-up is the largest
  // arrangement, so every out-of-range number lands on the same silent
  // no-op path rather than falling through to a macOS beep.
  //
  // `preventDefaultOnMatch` is not set: browsers have no default
  // meaning for ⌘1..⌘9 inside a WKWebView that we need to suppress.
  { key: "Digit1", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 1 },
  { key: "Digit2", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 2 },
  { key: "Digit3", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 3 },
  { key: "Digit4", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 4 },
  { key: "Digit5", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 5 },
  { key: "Digit6", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 6 },
  { key: "Digit7", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 7 },
  { key: "Digit8", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 8 },
  { key: "Digit9", meta: true, action: TUG_ACTIONS.MOVE_TO_SLOT, value: 9 },
  // ⇧⌘P selects the composer's Prompt route — P for Prompt, paired with ⇧⌘C
  // for Changes, so the two routes have matching chords.
  //
  // ⌃⌘P cycles the session card's permission mode. It sat on ⇧⌘P until the
  // routes claimed the P mnemonic; the incumbent moved rather than the route
  // giving up the letter. Tug deliberately departs from the Claude Code TUI
  // on this action either way: the terminal cycles permission mode on
  // Shift+Tab, but in a GUI Shift+Tab must move focus to the previous
  // control. The ⌃⌘ band is the coherent home for it — the band this map
  // otherwise vacated. Both doors move together: the Swift Session ▸
  // Permission Mode ▸ Cycle item carries the same modifier mask, or the
  // menu would keep swallowing the chord at the menu bar.
  //
  // Both are `scope: "key-card"`, routing to the active card's `card-content`
  // responder; only the session card registers handlers.
  // `preventDefaultOnMatch` suppresses the macOS beep when no session card
  // claims them (and any WebKit default). The chip / sheet and the
  // `/permissions` command remain the pick-a-mode affordances. Tab /
  // Shift-Tab are NOT in this map — the focus-walk stage in
  // `responder-chain-provider.tsx` owns them.
  { key: "KeyP", meta: true, shift: true, action: TUG_ACTIONS.SELECT_COMPOSER_ROUTE, value: "prompt", scope: "key-card", preventDefaultOnMatch: true },
  { key: "KeyP", ctrl: true, meta: true, action: TUG_ACTIONS.CYCLE_PERMISSION_MODE, scope: "key-card", preventDefaultOnMatch: true },
  // ⌘/ — the keyboard door to command discovery: focus the editor and seed a
  // leading `/`, which opens the slash-command completion popup. `scope:
  // "key-card"` so it fires card-wide (not only while the editor is focused);
  // the session card's card-content responder forwards it to the prompt
  // entry's `openCommandPicker`. `preventDefaultOnMatch` suppresses the
  // WebView default / macOS beep.
  { key: "Slash", meta: true, action: TUG_ACTIONS.OPEN_COMMAND_PICKER, scope: "key-card", preventDefaultOnMatch: true },
  // ⌥⌘/ opens the DevTools card (Log + Telemetry). Distinct from ⌘/ (command picker).
  { key: "Slash", meta: true, alt: true, action: TUG_ACTIONS.SHOW_DEVTOOLS, preventDefaultOnMatch: true },
  // Show/Hide Changes (⇧⌘C) and History (⇧⌘H) — the browser-dev twins of the
  // Swift Session-menu items ([P05], Spec S04). In Tug.app the menu key
  // equivalents (⌘⇧C / ⌘⇧H) win at the menu bar; these serve dev where no
  // Swift menu is present. `scope: "key-card"` routes to the active card's
  // card-content responder, which toggles the Shade.
  { key: "KeyC", meta: true, shift: true, action: TUG_ACTIONS.TOGGLE_CHANGES_VIEW, scope: "key-card", preventDefaultOnMatch: true },
  { key: "KeyH", meta: true, shift: true, action: TUG_ACTIONS.TOGGLE_HISTORY_VIEW, scope: "key-card", preventDefaultOnMatch: true },
  // ⌥⇥ toggles a text-first card's keyboard-focus-cycling mode — the mode in
  // which Tab circulates the card's chrome zones (the [D97] Z-areas) instead of
  // feeding the editor. `scope: "key-card"` routes to the active card's
  // `card-content` responder; only a text-first card (the session card first)
  // registers a handler, and the cycle focus-scope itself lands with the
  // mechanism. `preventDefaultOnMatch` suppresses the native default + the
  // macOS beep when no card claims it. ⌥⇥ is free here: the focus-walk stage in
  // `responder-chain-provider.tsx` bails on any modifier (it owns only the
  // unmodified Tab / Shift-Tab walk), so a modified Tab falls through to this
  // map rather than being consumed as a focus move.
  { key: "Tab", alt: true, action: TUG_ACTIONS.CYCLE_FOCUS_MODE, scope: "key-card", preventDefaultOnMatch: true },
  // ⌥⌘↑ / ⌥⌘↓ step the active card's transcript one turn back / forward.
  // `scope: "key-card"` routes to the active card's `card-content`
  // responder, so the chord walks up from wherever focus sits (prompt
  // editor included) — this is why it works card-wide where the list
  // view's own scroll-container PageUp/PageDown pager does not. ⌥↑/⌥↓
  // are intentionally avoided (editor word-movement); only the session card
  // registers a handler. `preventDefaultOnMatch` suppresses the native
  // default + macOS beep when no card claims it. Stage 1 runs in capture
  // phase before a focused editor sees the key, so the chord dispatches
  // even mid-compose.
  { key: "ArrowUp", alt: true, meta: true, action: TUG_ACTIONS.PREVIOUS_TURN, scope: "key-card", preventDefaultOnMatch: true },
  { key: "ArrowDown", alt: true, meta: true, action: TUG_ACTIONS.NEXT_TURN, scope: "key-card", preventDefaultOnMatch: true },
  // ⌥⇧⌘↑ / ⌥⇧⌘↓ jump the active card's transcript to the very top / very
  // bottom (Home / End). Same key-card routing as the turn-step chords
  // above, with shift added; the exact-modifier match in
  // `keyBindingMatchesEvent` keeps these distinct from the unshifted
  // ⌥⌘↑/↓ turn-step bindings.
  { key: "ArrowUp", alt: true, shift: true, meta: true, action: TUG_ACTIONS.FIRST_TURN, scope: "key-card", preventDefaultOnMatch: true },
  { key: "ArrowDown", alt: true, shift: true, meta: true, action: TUG_ACTIONS.LAST_TURN, scope: "key-card", preventDefaultOnMatch: true },
];

// ---- matchKeybinding ----

/** Chord key for the precompiled lookup: exact `code` + the exact state
 *  of all four modifier flags — the same identity
 *  {@link keyBindingMatchesEvent} tests pairwise. */
function chordKey(
  code: string,
  ctrl: boolean,
  meta: boolean,
  shift: boolean,
  alt: boolean,
): string {
  return `${code}|${ctrl ? 1 : 0}${meta ? 1 : 0}${shift ? 1 : 0}${alt ? 1 : 0}`;
}

/**
 * Precompiled chord → binding index. `matchKeybinding` runs on EVERY
 * capture-phase keydown in the app — a plain letter included — so the
 * lookup must be O(1), not a linear scan of the table. First writer
 * wins on a duplicate chord, matching the old first-match scan order.
 */
const KEYBINDING_INDEX: ReadonlyMap<string, KeyBinding> = (() => {
  const index = new Map<string, KeyBinding>();
  for (const binding of KEYBINDINGS) {
    const key = chordKey(
      binding.key,
      binding.ctrl ?? false,
      binding.meta ?? false,
      binding.shift ?? false,
      binding.alt ?? false,
    );
    if (!index.has(key)) index.set(key, binding);
  }
  return index;
})();

/**
 * Match a KeyboardEvent against the keybinding map.
 *
 * Returns the full KeyBinding object if a binding matches, or null if no match.
 * Uses KeyboardEvent.code (layout-independent) for the key field.
 *
 * [D06] Returns the full binding so callers can inspect preventDefaultOnMatch.
 */
export function matchKeybinding(event: KeyboardEvent): KeyBinding | null {
  return (
    KEYBINDING_INDEX.get(
      chordKey(
        event.code,
        !!event.ctrlKey,
        !!event.metaKey,
        !!event.shiftKey,
        !!event.altKey,
      ),
    ) ?? null
  );
}

/**
 * Whether a `KeyboardEvent` matches one binding's chord: exact `code` plus
 * exact state of all four modifier flags. The single matching rule, shared by
 * the static `matchKeybinding` and the dynamic, context-scoped registry
 * (`ResponderChainManager.resolveKeybinding`) so both layers agree on what
 * "this chord" means ([P11]).
 */
export function keyBindingMatchesEvent(
  event: KeyboardEvent,
  binding: KeyBinding,
): boolean {
  return (
    event.code === binding.key &&
    !!event.ctrlKey === (binding.ctrl ?? false) &&
    !!event.metaKey === (binding.meta ?? false) &&
    !!event.shiftKey === (binding.shift ?? false) &&
    !!event.altKey === (binding.alt ?? false)
  );
}
