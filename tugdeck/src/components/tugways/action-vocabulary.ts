/**
 * action-vocabulary.ts — the central registry of action names that
 * flow through the responder chain.
 *
 * Every action dispatched via `manager.sendToFirstResponder`, registered via
 * `useResponder`'s actions map, or bound in `keybinding-map.ts` must
 * reference a name from `TUG_ACTIONS` below. The `TugAction` union
 * is derived from `TUG_ACTIONS` via `as const`, so adding a new
 * action is one edit (the constants object) and the union, the
 * compile-time checks, and the call sites pick it up automatically.
 *
 * ## The constants idiom
 *
 * `TUG_ACTIONS` is the single source of truth. Each key is the
 * canonical `SCREAMING_SNAKE_CASE` constant name; each value is the
 * wire-format string dispatched on the chain. `TugAction` is
 * `typeof TUG_ACTIONS[keyof typeof TUG_ACTIONS] | Extra`, so the
 * union literally cannot drift from the constants. Call sites
 * always reference the constant, never a raw string literal:
 *
 * ```ts
 * controlDispatch.dispatch({ action: TUG_ACTIONS.CUT, phase: "discrete" });
 *
 * useResponder({
 *   id: cardId,
 *   actions: {
 *     [TUG_ACTIONS.CLOSE]: (_e: ActionEvent) => handleClose(),
 *   },
 * });
 * ```
 *
 * See `tuglaws/action-naming.md` for the naming convention, the
 * three-way classification (chain action / control frame / both),
 * and the enforcement policy.
 *
 * ## Vocabulary granularity decision (middle ground)
 *
 * One action per semantic, rich payloads carried on
 * `ActionEvent.value`. E.g. a single `set-value` action covers
 * sliders, value-inputs, and numeric fields, with the payload's
 * type documented alongside the constant in this file. This keeps
 * the name-level type union tight without exploding it into
 * per-control variants.
 *
 * Payload conventions are documented per-action below. Handlers
 * should narrow `event.value` defensively — TypeScript cannot
 * express "this value is a number *only* when action is set-value"
 * without a discriminated union, which would force all callers to
 * construct richly-typed ActionEvent objects at every dispatch
 * site. The current tradeoff is: tight action *names*, loose
 * `value` shape, with conventions documented here and enforced by
 * handler authors.
 *
 * Laws: [L11] controls emit actions; responders handle actions.
 *
 * When adding a new action:
 *   1. Pick a name following the `<verb>-<object>[-<modifier>]`
 *      rule from `tuglaws/action-naming.md`.
 *   2. Classify it: chain action, control frame, or both.
 *   3. For chain-action / both categories: add one entry to
 *      `TUG_ACTIONS` (or `TUG_GALLERY_ACTIONS`) in the appropriate
 *      section below, with an adjacent payload comment.
 *   4. Document the expected payload shape on `ActionEvent.value`.
 *   5. Document `ActionEvent.sender` expectations if multiple
 *      controls of the same kind can emit this action.
 *   6. Compile — the derived `TugAction` union picks up the new
 *      member automatically, so every call site referencing
 *      `TUG_ACTIONS.<NEW>` type-checks without any other edit.
 */

/* ---------------------------------------------------------------------------
 * TUG_ACTIONS — production action constants
 * ---------------------------------------------------------------------------
 *
 * Values are kebab-case wire strings per `tuglaws/action-naming.md`.
 * Keys are the SCREAMING_SNAKE_CASE canonical constant names every
 * call site references. Single-word names keep the same spelling
 * in both forms (`CUT` → `"cut"`); multi-word names convert at
 * word boundaries (`SELECT_ALL` → `"select-all"`).
 */
export const TUG_ACTIONS = {
  // ---- Clipboard ----
  //
  // NAMESPACE BOUNDARY: These kebab-case strings are chain-dispatch
  // names, NOT browser execCommand names. Handlers that call
  // document.execCommand must use the browser's own camelCase
  // vocabulary ("selectAll", "insertText", "delete", etc.).
  // See tuglaws/action-naming.md § "Action Names vs. Browser
  // Command Names" for the full rule.
  //
  // CUT:         payload — none. The first responder cuts its current
  //              selection. Handlers typically return a continuation for
  //              two-phase activation (copy to clipboard synchronously,
  //              delete the selection after the menu blink).
  // COPY:        payload — none. The first responder copies its current
  //              selection. No continuation expected.
  // COPY_AS_PLAIN_TEXT: payload — none. Like COPY, but the selection's
  //              Markdown source is stripped to plain text (headings,
  //              emphasis, code, links → their text content) before it
  //              lands on the clipboard. Plain-text only; no atom sidecar.
  //              Bound to ⌥⇧⌘C.
  // PASTE:       payload — none. The first responder pastes clipboard
  //              content. Handlers typically return a continuation so the
  //              paste happens after any menu activation animation.
  // PASTE_AS_QUOTE:      payload — none. Like PASTE, but the clipboard's
  //              plain text is rewritten as a Markdown blockquote (every
  //              line prefixed `> `) before insertion. Atom sidecars are
  //              ignored — the quote variant is plain-text only. Two-phase
  //              continuation like PASTE. Bound to ⌥⌘V.
  // PASTE_AS_PLAIN_TEXT: payload — none. Like PASTE, but Markdown
  //              formatting is stripped from the clipboard text (headings,
  //              emphasis, code, links → their text content) before
  //              insertion. Plain-text only; no atom sidecar. Bound to ⇧⌘V.
  // SELECT_ALL:  payload — none. The first responder selects all of its
  //              content. The handler calls document.execCommand("selectAll")
  //              — note the camelCase browser command name, not this
  //              kebab-case action name.
  // SELECT_NONE: payload — none. The first responder collapses its
  //              selection. NOTE: no responder currently registers a
  //              handler for this — dispatching is a silent no-op
  //              until a control wires it up.
  // COPY_COMMAND: payload — none. Copy the command span the right-click
  //              landed on (a command span in a transcript cell — see the
  //              annotator), preserving its code formatting:
  //              `text/plain` = the command in Markdown backticks,
  //              `text/html` = a `<code>` element. Menu-only (no keyboard
  //              binding); the handler reads the span text sampled at
  //              menu-open time, so it copies the WHOLE command regardless
  //              of any sub-word the browser smart-selected. Distinct from
  //              COPY, which copies the live selection.
  // COPY_COMMAND_AS_PLAIN_TEXT: payload — none. Like COPY_COMMAND but the
  //              bare command text only (`text/plain`, no backticks, no
  //              `text/html`) — the terminal-paste-friendly variant.
  // COPY_ANNOTATION_VALUE: payload — none. Copy the canonical value of the
  //              annotation the right-click landed on — the URL, the email
  //              address, the file path. Plain text only; the generalization
  //              of COPY_COMMAND_AS_PLAIN_TEXT to the kinds that have no
  //              code formatting to preserve. Menu-only; like the command
  //              copies, the handler reads the value sampled at menu-open
  //              time rather than the live selection, so it copies the
  //              WHOLE value regardless of any sub-word the browser
  //              smart-selected.
  // INSERT_INTO_PROMPT: payload — none. Send the sampled annotation back
  //              into the conversation: activate the card, then insert it
  //              into the prompt at the caret. Menu-only. This is
  //              the "indirect action" every annotation kind offers — a
  //              URL, a path, or a command line becomes something to talk
  //              about rather than something to follow. A file arrives as
  //              the chip an `@` mention mints rather than as its path
  //              characters, so it reads as one object and travels as one;
  //              every other kind arrives as its text.
  // COPY_COPYABLE: payload — none. Copy the text of the copyable the
  //              right-click landed on — a label, a badge, a timestamp, a
  //              sha. Menu-only, and menu-only for a structural reason: a
  //              copyable is `user-select: none`, so it can never be the
  //              document selection, and Edit ▸ Copy / ⌘C are performed by
  //              AppKit against that selection without entering this chain
  //              at all. A responder registering plain COPY here would
  //              therefore not gain a keyboard copy — it would only
  //              terminate the Edit-menu validation walk and light up a
  //              Copy item that copies nothing. See {@link useCopyableText}.
  // COPY_SESSION_ATOM: payload — none. Copy the session the right-click
  //              landed on as its atom: the citation as `text/plain` with the
  //              private atom sidecar beside it, so a paste back into any Tug
  //              editor returns the chip rather than the string.
  // COPY_SESSION_CITATION: payload — none. The same session as the flat
  //              sanctioned string — `<project>/<callsign> (<short id>)` —
  //              for anywhere outside Tug, where the sidecar means nothing.
  // COPY_SESSION_ID: payload — none. The session's full UUID, which is what
  //              every CLI verb and every JSONL path wants and what no
  //              rendered surface shows.
  // COPY_SESSION_DESCRIPTION: payload — none. The session's standing
  //              description IN FULL, past whatever the row had room for.
  // COPY_SESSION_ACTIVITY: payload — none. The newest live beat for that
  //              session. Only a beat copies: a rest sentence and a
  //              compaction pin are text the row composed rather than news
  //              the session sent, and the item is disabled when there is
  //              none.
  CUT:                 "cut",
  COPY:                "copy",
  COPY_AS_PLAIN_TEXT:  "copy-as-plain-text",
  COPY_COMMAND:        "copy-command",
  COPY_COMMAND_AS_PLAIN_TEXT: "copy-command-as-plain-text",
  COPY_ANNOTATION_VALUE: "copy-annotation-value",
  COPY_COPYABLE:       "copy-copyable",
  COPY_SESSION_ATOM:   "copy-session-atom",
  COPY_SESSION_CITATION: "copy-session-citation",
  COPY_SESSION_ID:     "copy-session-id",
  COPY_SESSION_DESCRIPTION: "copy-session-description",
  COPY_SESSION_ACTIVITY: "copy-session-activity",
  INSERT_INTO_PROMPT: "insert-into-prompt",
  PASTE:               "paste",
  PASTE_AS_QUOTE:      "paste-as-quote",
  PASTE_AS_PLAIN_TEXT: "paste-as-plain-text",
  SELECT_ALL:          "select-all",
  SELECT_NONE:         "select-none",

  // ---- Editing ----
  //
  // UNDO:      payload — none. macOS semantics: the innermost editor
  //            responder handles it against its own history; if none is
  //            focused, the nearest ancestor that registered for undo
  //            handles it (tab reopen, layout restore, etc.).
  // REDO:      payload — none. Symmetric with undo.
  // DELETE:    payload — none. The first responder deletes its current
  //            selection (or the item at the focus point).
  // DUPLICATE: payload — none. The first responder duplicates its
  //            current selection.
  // MAKE_UPPERCASE: payload — none. The first responder replaces its
  //            selection with the selection's text uppercased. A collapsed
  //            selection is a no-op — the verb acts on a selection, the way
  //            Delete does. Bound to ⌥⌘U.
  // MAKE_LOWERCASE: payload — none. The lowercase twin of MAKE_UPPERCASE.
  //            Bound to ⌥⌘L.
  UNDO:      "undo",
  REDO:      "redo",
  DELETE:    "delete",
  DUPLICATE: "duplicate",
  MAKE_UPPERCASE: "make-uppercase",
  MAKE_LOWERCASE: "make-lowercase",

  // ---- Text services ----
  //
  // LOOK_UP_IN_DICTIONARY: payload — `value: { text: string; x: number;
  //            y: number }`. Hand the selection to the system dictionary:
  //            the host answers with AppKit's definition panel, the same one
  //            every native text view shows. `text` is the selection sampled
  //            at menu-open time; `x` / `y` are the viewport (CSS) point the
  //            panel anchors to — the bottom-left of the selection's
  //            bounding rect, which is where AppKit wants the first
  //            character's baseline origin. Context-menu only: the verb
  //            means "this selection", and it is sampled where the sample is
  //            accurate rather than read back from a chain snapshot that is
  //            not selection-granular.
  LOOK_UP_IN_DICTIONARY: "look-up-in-dictionary",

  // ---- Editing motion / deletion ----
  //
  // These four actions are dispatched by the substrate-local text-editing
  // keybinding registry in `text-editing-keybindings.ts`, NOT by the
  // global `keybinding-map.ts` capture-phase pipeline. Movement and
  // deletion only ever target the focused text input, so the chain
  // abstraction adds nothing — see [DM01] in
  // `tugplan-text-editing-keybindings.md` for the substrate-local
  // wiring rationale.
  //
  // Sender for all four: "the focused text-editing responder" (the
  // `useTextInputResponder`-backed input/textarea, or the
  // `tug-text-editor` editor responder). Handlers read selection
  // state from the focused element / view at dispatch time per [L07];
  // there is no payload on the ActionEvent.
  //
  // DELETE_TO_LINE_START:  payload — none. Erase backward from the caret
  //                        to the start of the current line. For
  //                        single-line `<input>` this means index 0;
  //                        for `<textarea>` and CM6, the index after
  //                        the last `\n` at-or-before the caret. Native
  //                        substrates route through
  //                        `document.execCommand("delete")` so the
  //                        WKWebView's NSUndoManager records the
  //                        operation per [L23] / [DM03]; CM6 uses
  //                        `deleteLineBoundaryBackward` which pushes
  //                        onto the editor's `history()` stack per
  //                        [DM04]. Bound to Ctrl-U.
  // DELETE_WORD_BACKWARD:  payload — none. Erase the word ending at (or
  //                        immediately preceding) the caret. Word
  //                        boundaries come from the substrate's own
  //                        definition (native: `findWordBoundaries`
  //                        from `text-selection-adapter.ts`; CM6:
  //                        `deleteGroupBackward`). Bound to Ctrl-W.
  // MOVE_WORD_FORWARD:     payload — none. Move the caret one word
  //                        forward. With Shift held, the substrate
  //                        handler extends the selection rather than
  //                        moving the caret per [DM05]. Native
  //                        substrates read `event.shiftKey` from the
  //                        keystroke; CM6 uses the keymap entry's
  //                        `shift:` slot to bind `selectGroupForward`.
  //                        Chain dispatch (no native event) defaults
  //                        to no shift — settings/menu dispatch never
  //                        extends selection. Bound to Alt-F (Option-F).
  // MOVE_WORD_BACKWARD:    payload — none. Symmetric with
  //                        MOVE_WORD_FORWARD. Bound to Alt-B (Option-B).
  DELETE_TO_LINE_START: "delete-to-line-start",
  DELETE_WORD_BACKWARD: "delete-word-backward",
  MOVE_WORD_FORWARD:    "move-word-forward",
  MOVE_WORD_BACKWARD:   "move-word-backward",

  // ---- Submission ----
  //
  // TUG_ACTIONS.SUBMIT:
  //     payload — none. Dispatched by a form or submission-shaped
  //     control to mean "commit the current draft intent." The
  //     responder handler reads the live state from the store or
  //     delegate at dispatch time (per [L07]) to decide what
  //     "commit" means — send, interrupt, save, etc. For
  //     TugPromptEntry, the single action covers both send and
  //     interrupt depending on `snap.canInterrupt` at dispatch
  //     time (see plan [D05] for the submit/interrupt unification
  //     rationale). Phase is always `discrete`.
  //     sender — typically the submit button's id; handlers
  //     generally do not narrow on sender because any submit
  //     dispatch routed to the handler means the same thing.
  SUBMIT: "submit",

  // REMOVE_ATTACHMENT: payload — `value: string` (the atom id of the
  //     attachment to drop). Dispatched by the compose-phase attachment
  //     preview's ✕ / Delete controls; the prompt-entry responder owns
  //     the editor document + bytes store, so it handles the action by
  //     removing the atom and freeing its bytes. Phase `discrete`.
  REMOVE_ATTACHMENT: "remove-attachment",

  // ---- Navigation ----
  //
  // PREVIOUS_TAB:   payload — none. Step to the previous card in the
  //                 deck's lateral ring: every tab of every visible pane
  //                 (front of each slot / rail, plus free panes; the
  //                 sidebars ride it, rail included), one ring. Within a
  //                 pane it is a tab switch; at a pane's first tab it
  //                 crosses into the previous pane's last. Handled by the
  //                 deck canvas, which owns the geometry.
  // NEXT_TAB:       payload — none. The lateral ring's other direction.
  // FOCUS_NEXT:     payload — none. Move keyboard focus to the next
  //                 focusable responder. NOTE: no handler yet —
  //                 ⇥/⇧⇥ are deferred per the A3 / R4 retrospective.
  //                 Dispatching is a silent no-op until a chain-wide
  //                 focus-next implementation lands.
  // FOCUS_PREVIOUS: payload — none. Move keyboard focus to the previous
  //                 focusable responder. NOTE: no handler yet — see
  //                 FOCUS_NEXT.
  // FOCUS_PROMPT:   payload — none. Move keyboard focus into the key
  //                 card's prompt input. Used by ⌘K, scoped to
  //                 `scope: "key-card"`. Non-prompt cards (gallery,
  //                 git) don't register a handler; the dispatch is a
  //                 no-op and `preventDefaultOnMatch` suppresses the
  //                 native beep.
  // MOVE_TO_SLOT:   payload — `value: number` (1-based slot number).
  //                 Deck-level: put the selected card at slot N of the
  //                 active imposition. Used by ⌘1..9, handled by the deck
  //                 canvas, which owns the layout tree. The whole digit
  //                 row is bound so an out-of-range number is inert rather
  //                 than beeping: the handler no-ops when there is no
  //                 imposition, when nothing is selected, when the
  //                 selection is the rail, or when N exceeds the
  //                 arrangement's slot count.
  // NUDGE_SLOT:     payload — `value: number`, either -1 (left) or +1
  //                 (right). Deck-level: move every card in the layout
  //                 selection that many slots along the arrangement. Used
  //                 by ⌥⇧⌘[ / ⌥⇧⌘], handled by the deck canvas beside
  //                 MOVE_TO_SLOT. Relative where MOVE_TO_SLOT is absolute,
  //                 and so the one slot verb that can run off the end: the
  //                 group either moves whole or refuses whole, and the
  //                 refusal flashes the member that blocked it.
  // GO_TO_SLOT:    payload — `value: number` (1-based slot number).
  //                 Deck-level: take the reader to slot N — the band travels
  //                 to put it as near its middle as the strip allows, which
  //                 for the first and last slot is flush against that end.
  //                 Named for the arrival rather than the geometry for that
  //                 reason. Used by ⌃⌘1..6 (Window ▸ Go to Slot N), handled
  //                 by the deck canvas beside MOVE_TO_SLOT — the two are the
  //                 digit row's two readings, and the tier says which: ⌘n
  //                 sends the CARD to a place, ⌃⌘n sends the READER there.
  //                 Nothing is selected for it and nothing moves in the
  //                 arrangement; the only thing that travels is the band. So
  //                 it is inert under fit, where the band shows every anchor
  //                 already, and inert past the arrangement's slot count.
  // SET_PANE_WIDTH: payload — `value: string` (a `ContentWidth`: slim /
  //                 comfy / wide). Deck-level: put the SELECTED card's pane
  //                 at that named width. Its doors are Window ▸ Slim / Comfy
  //                 / Wide and the title bar's width popup — no chord: the
  //                 ⌃⌘ digits it held went to GO_TO_SLOT, which is the
  //                 hourly verb of the two. Handled by the deck canvas,
  //                 which owns the layout tree. The pane-addressed sibling
  //                 `SET_CARD_WIDTH` is the title bar's popup — the popup
  //                 names the pane it opened on, this one means "the pane
  //                 I am in". Both land on `setPaneWidth`, so the clamp and
  //                 the `widthPreset` stamp are the same on either door.
  // TOGGLE_BULLSEYE: payload — none. Deck-level: put the SELECTED card's
  //                 pane in bullseye — centered in the band at the comfy
  //                 width, with every other pane receded — or take it out
  //                 when it is already there. Used by ⌃⌘B (Window ▸
  //                 Bullseye), handled by the deck canvas, which owns the
  //                 layout tree and is the one responder that can name
  //                 which pane the selection is in. Selection-relative: it
  //                 resolves the pane and hands off to the pane-addressed
  //                 `SET_BULLSEYE`, which the title bar's target button
  //                 dispatches directly. A RAIL takes the posture too — its
  //                 place on the edge is reserved while it holds it.
  // REVEAL_STACK:   payload — none. Open the focused pane's slot-stack
  //                 picker — the title-bar menu listing every pane sharing
  //                 its slot. Used by ⌘R (Window ▸ Reveal Stack), answered
  //                 by the pane, which delegates to its title bar's
  //                 `revealStack()` handle. The handle toggles: this very
  //                 dispatch reaches an open menu's `observeDispatch`
  //                 subscription, and the responder action runs before any
  //                 observer, so a toggle is the one form that is
  //                 single-valued in both directions. The host validates
  //                 the item disabled below depth 2, so an inert press
  //                 never reaches here.
  // NEXT_STACK_CARD: payload — none. Bring the pane that has been buried
  //                 longest in the focused pane's slot to the front — the
  //                 depth axis of card navigation, the no-look counterpart
  //                 to REVEAL_STACK. ⌥⌘] (Window ▸ Next Card in Stack);
  //                 answered by the pane, which raises the LAST entry of
  //                 the `slotStack` it already renders its badge from.
  //                 Raising the bottom-most is what makes repeated presses
  //                 a ring: each raise sends the outgoing pane to the
  //                 back, so a depth-N slot returns home after N presses.
  //                 It is also ⌘`'s convention for windows. The host
  //                 validates the item disabled below depth 2, so an inert
  //                 press never reaches here.
  // PREVIOUS_STACK_CARD: payload — none. The exact inverse: send the
  //                 focused pane to the back of its slot's stack, fronting
  //                 the pane beneath it. ⌥⌘[ (Window ▸ Previous Card in
  //                 Stack); answered by the pane, which demotes itself via
  //                 `sendPaneBehind` and activates the next entry — a true
  //                 rotation, so NEXT undoes PREVIOUS at every depth
  //                 (raising the second-from-top instead would ping-pong).
  //                 Same depth-2 gate as its pair.
  // SELECT_COMPOSER_ROUTE: payload — `value: "prompt" | "changes"`.
  //                 Select one of the composer's two routes directly (as opposed
  //                 to TOGGLE_CHANGES_VIEW, which flips between them). Which
  //                 landing `"changes"` opens — a commit or a join — is the
  //                 card's to resolve from its binding, not a third value here.
  //                 Bound to
  //                 ⌃⌘P for `"prompt"`, scoped `scope: "key-card"`, handled
  //                 by the session card's card-content responder, which
  //                 applies it through the matching landing controller — the
  //                 single home of the route selection. Non-session cards register
  //                 no handler, so the dispatch is a silent no-op
  //                 (`preventDefaultOnMatch` suppresses the macOS beep).
  // CYCLE_PERMISSION_MODE: payload — none. Advance the session-card's
  //                 permission mode one step (default → acceptEdits →
  //                 plan → auto → default). Bound to ⌃⌥⌘P, scoped
  //                 `scope: "key-card"`, handled by the session card's
  //                 card-content responder. Non-dev cards register no
  //                 handler, so the dispatch is a silent no-op
  //                 (`preventDefaultOnMatch` suppresses the macOS beep).
  // INTERRUPT_SESSION: payload — none. Stop the in-flight turn:
  //                 Session ▸ Stop's control-frame round-trip (Both
  //                 category). The session card's card-content responder
  //                 calls `codeSessionStore.interrupt()`. Deliberately
  //                 NOT Escape's CANCEL_DIALOG walk — the menu item
  //                 always means interrupt; enablement (`canInterrupt`,
  //                 published via menuState) is the only gate.
  // CYCLE_FOCUS_MODE: payload — none. Toggle a text-first card's
  //                 keyboard-focus-cycling mode on/off — the mode in which
  //                 Tab circulates the card's chrome zones instead of feeding
  //                 the editor (the session card is the first consumer). Bound to
  //                 ⌥⇥, scoped `scope: "key-card"`; the trigger / Escape exit
  //                 back to the editor caret. The handler (a per-card cycle
  //                 focus-scope) lands with the cycle-mode mechanism; until then
  //                 the binding matches and suppresses the native default, but
  //                 the dispatch is a silent no-op. The focus-walk stage bails
  //                 on any modifier, so ⌥⇥ reaches this binding rather than
  //                 being consumed as a reverse-tab.
  // NEXT_KEYBOARD_FOCUS / PREVIOUS_KEYBOARD_FOCUS: payload — none. Advance the
  //                 keyboard focus ring one stop forward / back in the current
  //                 mode's authored order — what ⇥ and ⇧⇥ do once the focus
  //                 walk's precedence ladder has declined. `registry` routing
  //                 into `advanceKeyViewFocus`, because the ring is engine
  //                 state and no responder owns it. The View menu items carry
  //                 NO key equivalent: AppKit scans key equivalents before the
  //                 web view sees a keydown, so a literal ⇥ there would
  //                 confiscate Tab app-wide — above completion-accept, above
  //                 CM6's indentWithTab, above every native fallback.
  // RUN_SLASH_COMMAND: payload — `value: { name, args }` (a matched local
  //                 slash command + any trailing args). The prompt entry
  //                 dispatches it key-card-scoped when a typed `/command`
  //                 matches the local registry (`lib/slash-commands.ts`);
  //                 the session card's card-content responder handles it by
  //                 opening the command's graphical surface ([D23]).
  //                 Transport-independent — not gated on send-readiness.
  //                 A host with no handler leaves it unhandled, so the
  //                 prompt entry sends the text to claude instead.
  // INSERT_SLASH_COMMAND: payload — `value: { name }` (a command name). The
  //                 session card's card-content responder forwards it to the
  //                 prompt entry's `insertCommandChip`, seeding a leading
  //                 command chip ([P07]). Nothing dispatches it today: no
  //                 chord is assigned and no menu item names it, so the
  //                 handler is reachable only by an explicit dispatch.
  // OPEN_COMMAND_PICKER: payload — none. ⌘/ dispatches it key-card-scoped; the
  //                 session card's card-content responder forwards to the
  //                 prompt entry's `openCommandPicker` ([P06]).
  // INSERT_FILE:    payload — `value: { path }` (an absolute path). The host's
  //                 Session ▸ Insert File… item runs an NSOpenPanel and sends
  //                 the chosen path; ⌘I reaches the same item. Routed
  //                 first-responder and answered in two places: the prompt
  //                 entry itself, which inserts a `file` atom (basename
  //                 label, absolute value) at its caret — the shape an `@`
  //                 mention accepts — and the session card's card-content
  //                 responder, which forwards to its composer's delegate so
  //                 focus anywhere in the card still lands the file. A card
  //                 with no prompt entry answers neither, and that unhandled
  //                 walk is what dims the menu item.
  // SHOW_SLASH_COMMAND_NOTICE: payload — `value: { name, commandLine, reason }`
  //                 where `reason` is `"unknown"` (no such command — a typo) or
  //                 `"unsupported"` (a real Claude Code command with no meaning
  //                 over the bridge — the hidden set). The prompt entry
  //                 dispatches it key-card-scoped for a typed `/command` that
  //                 the session card will not run; the card-content responder
  //                 presents a `TugAlertSheet` with reason-appropriate text
  //                 instead of silently dropping it or burning a turn
  //                 ([#step-13a]). For `unknown`, a host with no handler leaves
  //                 it unhandled so the prompt entry falls through to claude;
  //                 a hidden command is never sent to claude regardless.
  // PREVIOUS_TURN / NEXT_TURN: payload — none. Step the session card's
  //                 transcript one turn (one entry) backward / forward,
  //                 pinning the target turn's top flush to the viewport
  //                 top. Bound to ⌥⌘↑ / ⌥⌘↓, `scope: "key-card"`, so the
  //                 chord walks from the first responder up to the
  //                 card-content responder regardless of where focus
  //                 sits in the card (transcript, prompt editor, status
  //                 bar) — unlike the list view's own scroll-container
  //                 PageUp/PageDown pager, which only fires when the
  //                 transcript holds focus. ⌥↑/⌥↓ are deliberately NOT
  //                 used (they are editor word-movement). The handler
  //                 drives `SessionTranscriptHandle.pageByEntry`.
  // FIRST_TURN / LAST_TURN: payload — none. Jump the session card's
  //                 transcript to the very top / very bottom (Home /
  //                 End). Bound to ⌥⇧⌘↑ / ⌥⇧⌘↓, `scope: "key-card"`,
  //                 same card-wide routing as PREVIOUS_TURN/NEXT_TURN.
  //                 FIRST_TURN drives `SessionTranscriptHandle.scrollToTop`
  //                 (disengages follow-bottom); LAST_TURN drives
  //                 `scrollToBottom` (re-engages follow-bottom at the
  //                 live edge).
  PREVIOUS_TAB:   "previous-tab",
  NEXT_TAB:       "next-tab",
  FOCUS_NEXT:     "focus-next",
  FOCUS_PREVIOUS: "focus-previous",
  FOCUS_PROMPT:   "focus-prompt",
  MOVE_TO_SLOT:   "move-to-slot",
  GO_TO_SLOT:    "go-to-slot",
  NUDGE_SLOT:     "nudge-slot",
  SET_PANE_WIDTH: "set-pane-width",
  TOGGLE_BULLSEYE: "toggle-bullseye",
  REVEAL_STACK:   "reveal-stack",
  PREVIOUS_STACK_CARD: "previous-stack-card",
  NEXT_STACK_CARD: "next-stack-card",
  SELECT_COMPOSER_ROUTE: "select-composer-route",
  CYCLE_PERMISSION_MODE: "cycle-permission-mode",
  INTERRUPT_SESSION: "interrupt-session",
  CYCLE_FOCUS_MODE: "cycle-focus-mode",
  NEXT_KEYBOARD_FOCUS: "next-keyboard-focus",
  PREVIOUS_KEYBOARD_FOCUS: "previous-keyboard-focus",
  PREVIOUS_TURN:  "previous-turn",
  NEXT_TURN:      "next-turn",
  FIRST_TURN:     "first-turn",
  LAST_TURN:      "last-turn",
  RUN_SLASH_COMMAND: "run-slash-command",
  INSERT_SLASH_COMMAND: "insert-slash-command",
  OPEN_COMMAND_PICKER: "open-command-picker",
  INSERT_FILE:    "insert-file",
  TOGGLE_CHANGES_VIEW: "toggle-changes-view",
  // REVEAL_CHANGES: payload — none. Open this card's Changes shade, sent by a
  //                 surface that shows the card's dash after fronting the
  //                 card. Not a toggle and not a chord: an explicit reveal
  //                 from elsewhere, answered by the session card's
  //                 card-content responder. It never closes the shade — the
  //                 route asked to open a room, and a second click on a row
  //                 must not slam the door.
  REVEAL_CHANGES: "reveal-changes",
  TOGGLE_HISTORY_VIEW: "toggle-history-view",
  SHOW_SLASH_COMMAND_NOTICE: "show-slash-command-notice",

  // ---- Dialog / popover ----
  //
  // CONFIRM_DIALOG:  payload — none. The first dialog-like responder
  //                  confirms its pending action.
  // CANCEL_DIALOG:   payload — none. The first dialog-like responder
  //                  cancels its pending action.
  // DISMISS_POPOVER: payload — none. Close the nearest popover.
  CONFIRM_DIALOG:  "confirm-dialog",
  CANCEL_DIALOG:   "cancel-dialog",
  DISMISS_POPOVER: "dismiss-popover",

  // ---- Control value ----
  //
  // SET_VALUE:       payload — shape depends on control:
  //                    - sliders, value-inputs: `value: number`
  //                    - inputs, textareas:     `value: string`
  //                    - others:                domain-specific
  //                  sender — the control's stable sender id (typically
  //                  useId). Handlers disambiguate multi-control forms
  //                  by inspecting sender.
  //                  phase — sliders and scrubbable controls use
  //                  "begin" / "change" / "commit" for interactive
  //                  dragging. Discrete changes use "discrete".
  // TOGGLE:          payload — `value: boolean` (the new state). Used by
  //                  checkboxes, switches, and expand/collapse controls.
  //                  sender — stable sender id.
  // SELECT_VALUE:    payload — `value: string` (the selected item id).
  //                  Used by radio groups, choice groups, dropdowns,
  //                  tab bars.
  //                  sender — stable sender id identifying which control
  //                  or group dispatched the selection.
  // INCREMENT_VALUE: payload — optional `value: number` (step override).
  //                  Used by numeric scrubbers on arrow-up.
  // DECREMENT_VALUE: payload — optional `value: number` (step override).
  //                  Used by numeric scrubbers on arrow-down.
  // SET_COLOR:       payload — `value: TugColorSpec` ({ hue, adjacent?, i, t, a }).
  //                  Dispatched by the standalone TugColorPicker via
  //                  sendToTarget(targetId, …) to the host responder that owns
  //                  the active color well; sender — the well's stable sender id,
  //                  so a multi-well host routes the edit to the right color.
  // ACTIVATE_COLOR_WELL: payload — `value: TugColorSpec` (the well's current
  //                  color) plus optional `label: string`. Dispatched by a
  //                  TugColorWell to its parent responder on click; the host
  //                  records itself as the active color target (active-color-
  //                  target.ts) so the picker knows what to edit. sender — the
  //                  well's stable sender id.
  SET_COLOR:       "set-color",
  ACTIVATE_COLOR_WELL: "activate-color-well",
  SET_VALUE:       "set-value",
  TOGGLE:          "toggle",
  SELECT_VALUE:    "select-value",
  INCREMENT_VALUE: "increment-value",
  DECREMENT_VALUE: "decrement-value",

  // ---- Tab operations ----
  //
  // SELECT_TAB: payload — `value: string` (tab id).
  // CLOSE_TAB:  payload — `value: string` (tab id).
  // ADD_TAB:    payload — `value: string` (componentId of the new tab).
  //             Dispatched by card-level "new tab" controls (e.g. the
  //             tab bar's `+` popup-button menu). The responder that
  //             handles it (typically `TugPane`) uses its own cardId
  //             plus the componentId from the payload to call
  //             `store.addTab(cardId, componentId)`. Distinct from
  //             `add-card-to-active-pane`, which is the global
  //             menu/keystroke path that targets the focused pane with
  //             a hardcoded component type.
  // REOPEN_TAB: payload — none. Restore the most recently closed tab.
  //             NOTE: no handler yet — ⌘⇧T is deferred per the A3 / R4
  //             retrospective pending a closed-tab history in
  //             deck-manager. Dispatching is a silent no-op until then.
  SELECT_TAB: "select-tab",
  CLOSE_TAB:  "close-tab",
  ADD_TAB:    "add-tab",
  REOPEN_TAB: "reopen-tab",

  // ---- Document viewing ----
  //
  // A paged document surface — today the viewer card's PDF branch — owns
  // these while it is the first responder. They are deliberately generic:
  // a second paged viewer would register the same handlers rather than
  // grow a parallel vocabulary.
  //
  // SCROLL_DOCUMENT: payload — `value: { axis: "horizontal" | "vertical";
  //                  amount: "line" | "page" | "document"; direction: -1 | 1 }`.
  //                  One action behind every navigation key, because what a
  //                  key should do depends on the surface's current mode:
  //                  the same ↓ scrolls in a continuously-scrolled document
  //                  and turns the page in a paged one. The handler owns
  //                  that reading; the binding only says how far and which
  //                  way.
  // SET_PAGE_MODE:   payload — `value: "continuous" | "single" | "two"`.
  //                  How pages are grouped and laid out.
  // ZOOM_IN / ZOOM_OUT: payload — none. Step the surface's zoom ladder.
  // ZOOM_ACTUAL:     payload — none. Return to 1:1.
  // ZOOM_TO_FIT:     payload — `value: "width" | "page"`. Fit the current
  //                  page to the surface by width, or whole. A fit is stored
  //                  as the choice rather than the scale it measured, so it
  //                  re-fits when the surface resizes.
  SCROLL_DOCUMENT: "scroll-document",
  SET_PAGE_MODE: "set-page-mode",
  ZOOM_IN: "zoom-in",
  ZOOM_OUT: "zoom-out",
  ZOOM_ACTUAL: "zoom-actual",
  ZOOM_TO_FIT: "zoom-to-fit",

  // ---- Accordion / section ----
  //
  // TOGGLE_SECTION: payload — `value: string | string[]` (id or list of
  //                 ids for single vs. multi-expand accordions).
  TOGGLE_SECTION: "toggle-section",

  // ---- Pane / card ----
  //
  // CLOSE:                  payload — none. Close the first card responder.
  // CLOSE_ALL:              payload — none. Close every tab in the focused
  //                         multi-card pane (the pane goes away). The pane's
  //                         registered handler pops the "Close N Tabs?"
  //                         confirm when any hosted card opts into
  //                         `confirmClose`, closes immediately otherwise.
  //                         Dispatched by File ▸ Close All Card Tabs (⌥⌘W).
  // CLOSE_PANE:             payload — none. Close the whole pane addressed by
  //                         the dispatch's target — the pane's own X button,
  //                         aimed from somewhere else. The handler runs the
  //                         title bar's close flow entire: every hosted card's
  //                         save guard first, then the pane's confirm policy
  //                         ("Close N Tabs?" on a multi-tab pane). Distinct
  //                         from CLOSE_ALL, whose confirm is per-card because
  //                         its caller is a deliberate menu command; this one
  //                         answers a close box in a list, where a stray click
  //                         must never destroy a stack outright. Sent with
  //                         `sendToTarget(paneId, …)` — the pane registers it
  //                         under its own id.
  // MINIMIZE:               payload — none. Minimize the first card.
  // MAXIMIZE:               payload — none. Maximize the first card.
  // SHOW_COMPONENT_GALLERY: payload — none. Open or focus the gallery card.
  // SHOW_SETTINGS:          payload — none. Open the settings panel.
  // SHOW_KEYBOARD_SHORTCUTS: payload — none. Open or focus the Keyboard
  //                         Shortcuts card.
  // SHOW_DEVTOOLS:          payload — none. Open or focus the DevTools card.
  // TOGGLE_JOTS:            payload — none. Show/hide the Jots rail. A menu
  //                         row, chord-less by default: the keyboard addresses
  //                         the RAIL (TOGGLE_RAIL), not the cards on it.
  // TOGGLE_TRIPWIRES:       payload — none. Show/hide the Tripwires rail. As
  //                         above.
  // TOGGLE_ARCS:            payload — none. Show/hide the Arcs rail. As
  //                         above.
  // TOGGLE_CARDS:           payload — none. Show/hide the Cards rail. As
  //                         above.
  // TOGGLE_LAYOUT:          payload — none. Show/hide the Layout rail. As
  //                         above.
  // TOGGLE_OVERVIEW:         payload — none. Show/hide the Overview rail. As
  //                         above.
  // TOGGLE_RAIL:            payload — `value: "left" | "right"`. ⌃⌘← / ⌃⌘→.
  //                         Show/hide a whole SIDE of the deck, three-state:
  //                         hidden → show it and focus its frontmost member;
  //                         showing → focus that member; focused → hide the
  //                         rail. Showing brings back the members standing
  //                         when it was hidden.
  // NEW_JOT:                payload — none. Capture a jot in one gesture:
  //                         reveal the Jots card if it is hidden, create an
  //                         empty jot, and land the caret in its editor.
  // RESET_LAYOUT:           payload — none. Reset card positions.
  // ADD_CARD_TO_ACTIVE_PANE: payload — none. Add a new card to the active pane
  //                         via the global menu / ⌘T (canvas targets the first responder).
  // FIND:                   payload — none. Open the find UI for the first
  //                         searchable responder.
  // FIND_NEXT:              payload — none. Advance to the next match against
  //                         the active find query. The first responder up the
  //                         chain that owns a find session handles it.
  //                         Empty / invalid query → no-op so the keystroke
  //                         doesn't accidentally seed a query from the
  //                         current selection. Dispatched by ⌘G.
  // FIND_PREVIOUS:          payload — none. Symmetric with FIND_NEXT.
  //                         Dispatched by ⇧⌘G.
  // FIND_SELECTION:         payload — none. Make the surface's current
  //                         selection the find query and run it: show the
  //                         find UI if it is hidden, seed the query field
  //                         with the selected text, and land on the first
  //                         match. Handled by the surface that owns the
  //                         selection model (the Session card reads the DOM
  //                         selection inside the card; the Text card editor
  //                         reads its CM6 range), which is also what makes
  //                         it inapplicable with nothing selected.
  //                         Dispatched by ⌘E.
  // SAVE:                   payload — none. Flush the first responder's
  //                         pending edits to disk now. Under the live
  //                         autosave model there is no dirty state —
  //                         SAVE is "write immediately + checkpoint",
  //                         not "persist or lose". Dispatched by ⌘S and
  //                         File ▸ Save; handled by editing surfaces
  //                         that own a disk binding (`TugTextCardEditor`).
  // SAVE_AS:                payload — none. Manual-mode "Save As…": run the
  //                         save panel and re-anchor the buffer to the
  //                         chosen path (the classic ⇧⌘S). Dispatched by
  //                         File ▸ Save As…; handled at the Text card scope.
  // SAVE_A_COPY:            payload — none. Write a copy of the buffer to a
  //                         chosen path without rebinding or clearing the
  //                         dirty bit (⌥⇧⌘S). File ▸ Save a Copy….
  // REVERT_TO_SAVED:        payload — none. Discard buffer edits back to the
  //                         last saved version (after a confirm sheet).
  //                         File ▸ Revert to Saved.
  // RELOAD_FROM_DISK:       payload — none. Reload the on-disk version,
  //                         discarding edits (confirm sheet only while
  //                         dirty). File ▸ Reload from Disk.
  // OPEN_FILE:              payload — `{ path: string, line?: number, endLine?: number,
  //                         columns?: [number, number] }` — or `{ targets: [...] }`
  //                         to open several references as ONE gesture (`/ref 1-5`);
  //                         via `dispatchCommand` / Control frames, or a
  //                         chain dispatch whose `value` is the path
  //                         string (context-menu items). Open `path` in
  //                         a Text card: an existing card bound to the
  //                         same path is activated and jumped to `line`;
  //                         otherwise a new Text card is created seeded
  //                         with the path. DeckCanvas's chain handler
  //                         takes both shapes and calls `openFileInCard`.
  // REVEAL_IN_FINDER:       payload — `value: string` (absolute path).
  //                         Reveal the path in the macOS Finder via the
  //                         host bridge (`openPathInOS`). Dispatched by
  //                         file-reference context menus; handled by
  //                         DeckCanvas (deck-level, card-independent).
  // REVEAL_CARD_FILE:       payload — none. Reveal THIS card's own bound
  //                         file in the Finder. Deliberately not
  //                         REVEAL_IN_FINDER, which means "the path the
  //                         pointer sampled" and carries that path as its
  //                         payload: a title-bar button has no pointer
  //                         target and always means the document the card
  //                         is showing, which only the chain can resolve.
  //                         Dispatched by the pane's title bar; handled by
  //                         the card's first responder.
  // SHOW_CARD_SETTINGS:     payload — none. Open the card-local view
  //                         settings for whatever kind of document the card
  //                         is showing — the Text card's editor options,
  //                         the viewer's image or PDF settings — as a card
  //                         sheet. One command, not one per kind: the
  //                         gesture is "settings for THIS card", and the
  //                         card that handles it is the only thing that
  //                         needs to know what kind it is. Dispatched by
  //                         the pane's title bar; handled by the card's
  //                         first responder.
  // OPEN_IMAGE_PREVIEW:     payload — `value: string` (an atom id). Open
  //                         the full-resolution lightbox for an image
  //                         carried as bytes rather than as a file, at
  //                         whichever attachment strip holds that atom
  //                         (`lib/attachment-preview-open.ts`). Dispatched
  //                         by the transcript's image-atom annotations.
  // ---- Deck verbs that had no name ----
  //
  // These five were reachable only as `DeckManager` method calls — a
  // drag, a rail row, an internal caller — so no table could see them and
  // no keymap could offer them. Naming them is what makes them commands.
  //
  // CENTER_PANE:     payload — none. Put the addressed card's pane in the
  //                  middle of the canvas (`DeckManager.centerPane`).
  // PIN_SIDEBAR:     payload — none. Re-attach a rail to the canvas edge
  //                  after a manual move or resize has floated it.
  // SHOW_SIDEBAR_PANE / HIDE_SIDEBAR_PANE: payload — none. The two explicit
  //                  halves of what a TOGGLE_* row flips, so a caller that
  //                  means "show" cannot accidentally hide.
  // MOVE_PANE:       payload — `{ paneId, position?, size? }`. Reposition or
  //                  resize a pane; the drag coordinator's verb.
  CENTER_PANE:            "center-pane",
  PIN_SIDEBAR:            "pin-sidebar",
  SHOW_SIDEBAR_PANE:      "show-sidebar-pane",
  HIDE_SIDEBAR_PANE:      "hide-sidebar-pane",
  MOVE_PANE:              "move-pane",

  // ---- Deck verbs that were menu wires only ----
  //
  // These arrived as Control frames from the host menu and were serviced
  // by a registered handler, so they existed nowhere the responder chain
  // could see: not dispatchable in browser dev, not askable for validity,
  // not shadowable, not bindable. They act on the deck, DeckCanvas is the
  // deck's responder, and naming them is what lets it answer for them.
  //
  // NEW_TEXT_CARD:           payload — none. Open an untitled manual
  //                          buffer in its own Text card; no file exists
  //                          until the first Save. File ▸ New Text File.
  // OPEN_QUICKLY:            payload — none. Open the deck-global
  //                          file-search popup. File ▸ Open Quickly.
  // CLEAR_RECENT_DOCUMENTS:  payload — none. Empty the MRU list and
  //                          re-publish it to the host. File ▸ Open Recent
  //                          ▸ Clear Menu.
  // FOCUS_PANE:              payload — `{ paneId: string }`. Bring a pane
  //                          to front through the full activation
  //                          transition. The Window menu's pane list.
  NEW_TEXT_CARD:          "new-text-card",
  OPEN_QUICKLY:           "open-quickly",
  CLEAR_RECENT_DOCUMENTS: "clear-recent-documents",
  FOCUS_PANE:             "focus-pane",

  // ---- Commit mode ----
  //
  // `enter` has doors (the ⌃⌘C shade toggle and `/commit`); its two exits
  // were controller methods only.
  //
  // EXIT_COMMIT_MODE:     payload — none. Leave commit mode, restoring the
  //                       stashed prompt draft.
  // LAND_COMMIT:          payload — `value: string` (the commit message).
  //                       Commit what the Changes sheet is showing.
  // COMMIT_AUTO_MESSAGE:  payload — none. Ask the scribe for a commit
  //                       message. The keyboard twin of the composer's
  //                       pencil-sparkles button, and inert mid-draft.
  // CLAIM_ALL_CHANGES:    payload — none. Claim every file the Changes shade
  //                       offers this session: the unattributed bucket AND the
  //                       orphaned one, in one verb. The shade wires the two
  //                       buckets as separate buttons; the chord takes both.
  // DISCLAIM_ALL_CHANGES: payload — none. Renounce every file in this
  //                       session's changeset entry. The counterpart of
  //                       CLAIM_ALL_CHANGES, not its set-inverse: one acts on
  //                       what is not yet this session's, the other on what is.
  EXIT_COMMIT_MODE:       "exit-commit-mode",
  LAND_COMMIT:            "land-commit",
  COMMIT_AUTO_MESSAGE:    "commit-auto-message",
  CLAIM_ALL_CHANGES:      "claim-all-changes",
  DISCLAIM_ALL_CHANGES:   "disclaim-all-changes",

  CLOSE:                  "close",
  CLOSE_ALL:              "close-all",
  CLOSE_PANE:             "close-pane",
  MINIMIZE:               "minimize",
  MAXIMIZE:               "maximize",
  SHOW_COMPONENT_GALLERY: "show-component-gallery",
  SHOW_SETTINGS:          "show-settings",
  SHOW_KEYBOARD_SHORTCUTS: "show-keyboard-shortcuts",
  SHOW_DEVTOOLS:          "show-devtools",
  TOGGLE_JOTS:            "toggle-jots",
  TOGGLE_TRIPWIRES:       "toggle-tripwires",
  TOGGLE_ARCS:            "toggle-arcs",
  TOGGLE_CARDS:           "toggle-cards",
  TOGGLE_LAYOUT:          "toggle-layout",
  TOGGLE_OVERVIEW:         "toggle-overview",
  TOGGLE_RAIL:            "toggle-rail",
  NEW_JOT:                "new-jot",
  // SET_CARD_WIDTH: payload — `{ paneId, preset }`. Set one content pane's
  //                 width to a named preset (slim / comfy / wide), clamped up
  //                 to the pane's stack floor and stamped so a picker can show
  //                 which one it is at. Its door is the pane title bar's width
  //                 popup.
  SET_CARD_WIDTH:         "set-card-width",
  // SET_BULLSEYE:   payload — `{ paneId }`. Put ONE named pane in bullseye, or
  //                 take it out when it is already there. The pane-addressed
  //                 sibling of `TOGGLE_BULLSEYE`, in the shape SET_PANE_WIDTH →
  //                 SET_CARD_WIDTH already has: the title bar's target button
  //                 names the pane it stands on, and the chord means "the pane
  //                 I am in" and dispatches here once it has resolved which
  //                 that is. Both doors therefore land on one store call.
  SET_BULLSEYE:           "set-bullseye",
  // SET_CONTENT_WIDTH: payload — `{ preset }`. Set the deck's default content
  //                    width and put every content pane on it, overwriting the
  //                    per-pane widths the title-bar popup had set. Its door is
  //                    the rail Layouts section's Card Width group.
  SET_CONTENT_WIDTH:      "set-content-width",
  // SET_IMPOSITION_LAYOUT: payload — `{ layout }`. Choose how the deck resolves
  //                        its slots: `"fit"`, where each slot is an anchor at
  //                        a fraction of the band and a narrow deck overlaps
  //                        its cards, or `"flow"`, where the occupied slots
  //                        stand in a strip that runs off the right edge and
  //                        the active card is revealed into view. Its door is
  //                        the rail Layouts section's Layout group.
  SET_IMPOSITION_LAYOUT:  "set-imposition-layout",
  // SET_SIDEBAR_SIDE: payload — `{ componentId, side }`. Move a sidebar card to
  //                   a deck edge, re-pinning it if it had been dragged loose.
  //                   Its door is the rail Layouts section's sidebar positions
  //                   group, which draws one control per registered sidebar
  //                   card.
  SET_SIDEBAR_SIDE:       "set-sidebar-side",
  // SET_SIDEBAR_OPEN: payload — `{ componentId, open }`. Show or hide a
  //                   sidebar card outright, with no activation dance: the
  //                   three-state View-menu toggles (TOGGLE_CARDS et al.) are a
  //                   summons, this is a placement fact. Its door is the Layout
  //                   card's per-card row, whose Off segment is the
  //                   hide and whose side segments show a hidden card where
  //                   they say.
  SET_SIDEBAR_OPEN:       "set-sidebar-open",
  // SET_SLOT_WINDOW: payload — `{ size }`, 3 or 5. How many places a rail row
  //                  draws around the one its card holds. A reading
  //                  preference rather than a deck fact — it moves no card and
  //                  changes no arrangement — so it is persisted through
  //                  tugbank and nothing about the deck's state knows it
  //                  happened. Its door is the rail Layouts section's Slot
  //                  Window row.
  SET_SLOT_WINDOW:        "set-slot-window",
  // SET_RAIL_MODE: payload — `{ side, mode }`. Stack or split one side's rail:
  //                stacked, its sidebar cards stand front-to-back and z-order
  //                decides which you see; split, the side's run is divided
  //                between them and every member is visible at once. Stack is
  //                the default. Its doors are the title bar's stack badge menu
  //                and the rail Layouts section's per-side rail row.
  SET_RAIL_MODE:          "set-rail-mode",
  // EQUALIZE_RAIL: payload — `{ side }`. Divide a split rail's run equally
  //                again, discarding the heights a seam drag set while keeping
  //                the side's mode and member order. Its doors are the stack
  //                badge menu and a double-click on the seam itself.
  EQUALIZE_RAIL:          "equalize-rail",
  // SET_COLUMN_MODE: payload — `{ slot, mode }`. The content-side twin of
  //                  SET_RAIL_MODE: stack or split the cards sharing one
  //                  numbered slot. Stacked they stand front-to-back and
  //                  z-order decides which you see; split, the slot's vertical
  //                  run is divided between them. Stack is the default. Its
  //                  doors are the title bar's stack badge menu, the rail
  //                  Layouts section's per-slot column row, and ⌃⌘S.
  SET_COLUMN_MODE:        "set-column-mode",
  // EQUALIZE_COLUMN: payload — `{ slot }`. Divide a split column's run equally
  //                  again, discarding the heights a seam drag set while
  //                  keeping the slot's mode and member order. Its doors are
  //                  the stack badge menu and a double-click on the seam.
  EQUALIZE_COLUMN:        "equalize-column",
  // TOGGLE_COLUMN_SPLIT: payload — none. ⌃⌘S. Split or re-stack the slot
  //                      holding the layout selection's first card (else the
  //                      first responder's). Resolved by the deck canvas, which
  //                      is the one responder that can name a slot, and refused
  //                      visibly on a slot holding one card.
  TOGGLE_COLUMN_SPLIT:    "toggle-column-split",
  // MOVE_IN_COLUMN: payload — `value: "up" | "down" | "top" | "bottom"`.
  //                 ⌃⌘↑/↓ and ⌃⇧⌘↑/↓. Move the resolved card within its
  //                 column: its place in the split order, or its place in the
  //                 stack's z-order when the column is not divided. Refusal at
  //                 an edge flashes the pane.
  MOVE_IN_COLUMN:         "move-in-column",
  RESET_LAYOUT:           "reset-layout",
  ADD_CARD_TO_ACTIVE_PANE: "add-card-to-active-pane",
  FIND:                   "find",
  FIND_NEXT:              "find-next",
  FIND_PREVIOUS:          "find-previous",
  FIND_SELECTION:         "find-selection",
  SAVE:                   "save",
  SAVE_AS:                "save-as",
  SAVE_A_COPY:            "save-a-copy",
  REVERT_TO_SAVED:        "revert-to-saved",
  RELOAD_FROM_DISK:       "reload-from-disk",
  OPEN_FILE:              "open-file",
  // OPEN_DIFF:              payload — `{ descriptor: DiffDescriptor }` (a
  //                         head or range diff, `lib/git-diff-store.ts`).
  //                         Open the diff in a Diff card: an existing card
  //                         showing the same descriptor (by
  //                         `diffDescriptorKey`) is activated; otherwise a
  //                         new Diff card is created seeded with the
  //                         descriptor. Registry handler in
  //                         `action-dispatch.ts`; both call `openDiffInCard`.
  OPEN_DIFF:              "open-diff",
  REVEAL_IN_FINDER:       "reveal-in-finder",
  REVEAL_CARD_FILE:       "reveal-card-file",
  SHOW_CARD_SETTINGS:     "show-card-settings",
  OPEN_IMAGE_PREVIEW:     "open-image-preview",

  // ---- Dev session management ----
  //
  // REQUEST_TRASH_SESSION:  payload — `{ sessionId: string }`. Dispatched
  //                         by the trash icon on a `session-resume` row
  //                         in the Dev picker; handled by the picker
  //                         form responder, which sets a pending-id state
  //                         that drives a single anchored `TugConfirmPopover`.
  //                         The actual move-to-trash runs in the form's
  //                         `onConfirm` callback after the user confirms.
  //                         The "request" verb signals the action does
  //                         NOT trash on its own — the responder owns
  //                         the confirmation UI.
  //                         sender — auto-derived stable id from the
  //                         emitting `TugIconButton`; rarely matters
  //                         because the `sessionId` payload disambiguates.
  //                         See [tugplan-session-picker-redesign §D14](
  //                         ../../../dash/tugplan-session-picker-redesign.md#d14-no-per-cell-popovers).
  REQUEST_TRASH_SESSION: "request-trash-session",

  // SHOW_SESSION:           payload — none. Raise the card already showing the
  //                         session the right-click landed on: front its pane
  //                         and give it the key view. The menu offers this only
  //                         when a card holds that session, and never on the
  //                         session's OWN card, where it would raise the card
  //                         the pointer is already in.
  // RESUME_SESSION:         payload — none. The other half of that pair, for a
  //                         session no card holds: open a fresh session card
  //                         and restore the session into it. A session another
  //                         process holds is not resumable and the item is
  //                         disabled rather than absent, so the menu's height
  //                         does not depend on what the ledger last said.
  SHOW_SESSION:          "show-session",
  RESUME_SESSION:        "resume-session",

  // ---- The commit a right-click landed on ----
  //
  // Every one of these is menu-only over a sampled target — "the commit the
  // pointer is on", which no chord can name — and every one is handled by the
  // row's own responder ({@link useCommitIdentityMenu}).
  //
  // TOGGLE_COMMIT_DETAIL:   payload — none. Fold the commit's detail open or
  //                         shut, the same act the row's click performs. The
  //                         item SAYS which way it will go, so the menu never
  //                         asks the reader to remember the row's state.
  // COPY_COMMIT_HASH:       payload — none. The complete 40-char hash — what
  //                         every git verb wants and what no row displays.
  //                         Bare, with no `commit:` word in front of it: it is
  //                         an argument, not a reference.
  // COPY_COMMIT_SHORT_HASH: payload — none. `commit:<8>` — the atom's own
  //                         text, the form the app writes a commit as.
  // COPY_COMMIT_HEADER:     payload — none. `commit:<8> <subject>` — the
  //                         reference and what it did, one line.
  // COPY_COMMIT_RECORD:     payload — none. The whole record — header line,
  //                         attribution, message — the same text the row's
  //                         Copy button writes, so the two cannot drift.
  TOGGLE_COMMIT_DETAIL:   "toggle-commit-detail",
  COPY_COMMIT_HASH:       "copy-commit-hash",
  COPY_COMMIT_SHORT_HASH: "copy-commit-short-hash",
  COPY_COMMIT_HEADER:     "copy-commit-header",
  COPY_COMMIT_RECORD:     "copy-commit-record",

  // ---- The dash row's rare verbs ----
  //
  // Menu-only over a sampled target — "the dash this row is" — and handled by
  // the row's own responder ({@link useArcRowMenu}). None is a chord: a
  // discard is not a thing to reach by typing, and a bind is a decision about
  // which dash a card works on, made by pointing at the dash.
  //
  // BIND_DASH:              payload — none. Mate this card's session to the
  //                         dash the menu was opened on.
  // UNBIND_DASH:            payload — none. The complement, on the row this
  //                         card is already mated to. The two never appear
  //                         together — the row carries whichever it is.
  // REQUEST_DISCARD_DASH:   payload — none. "Request", like
  //                         REQUEST_TRASH_SESSION: the item arms the lane's
  //                         one confirm popover rather than discarding, and
  //                         the popover names what the discard destroys.
  // REQUEST_REPLAY_ARC:     payload — none. Replay the arc's rounds onto its
  //                         base branch's current tip. "Request" because the
  //                         act is the server's: the item sends
  //                         `changeset_replay` and the outcome comes back on
  //                         the wire, including the common outcomes that move
  //                         nothing and report on the pane bulletin.
  BIND_DASH:              "bind-dash",
  UNBIND_DASH:            "unbind-dash",
  REQUEST_DISCARD_DASH:   "request-discard-dash",
  REQUEST_REPLAY_ARC:     "request-replay-arc",

  // ---- Meta ----
  //
  // SET_PROPERTY: payload — `{ path: string; value: unknown; source?: string }`.
  //               Routes to the first responder's registered PropertyStore
  //               (if any). Used by the inspector to drive live property
  //               updates.
  SET_PROPERTY: "set-property",
} as const;

/* ---------------------------------------------------------------------------
 * TUG_GALLERY_ACTIONS — demo / test-only actions
 * ---------------------------------------------------------------------------
 *
 * These are used only by gallery cards and tests to demonstrate chain
 * features (mutation-tx previews, chain-action buttons). They are
 * not intended for production use. Exported as a separate constants
 * object (and derived `GalleryAction` union) so galleries can opt in
 * via the `TugAction<GalleryAction>` generic parameter. Production
 * code uses bare `TugAction` and never sees these names in
 * autocomplete.
 *
 * DEMO_ACTION:      payload — none. Generic "something happened" for
 *                   the chain-actions gallery demonstration.
 * PREVIEW_COLOR:    payload — `{ color: string }` plus phase semantics
 *                   for scrub preview.
 * PREVIEW_HUE:      payload — `{ hue: number }` plus phase semantics.
 * PREVIEW_POSITION: payload — `{ x: number; y: number }` plus phase
 *                   semantics for draggable element preview.
 */
export const TUG_GALLERY_ACTIONS = {
  DEMO_ACTION:      "demo-action",
  PREVIEW_COLOR:    "preview-color",
  PREVIEW_HUE:      "preview-hue",
  PREVIEW_POSITION: "preview-position",
} as const;

/* ---------------------------------------------------------------------------
 * Derived types
 * ---------------------------------------------------------------------------*/

/**
 * The complete set of typed action names recognized by the responder
 * chain. Every ActionEvent's `action`, every `useResponder` actions
 * map key, and every KeyBinding.action must be one of these.
 *
 * Derived from `TUG_ACTIONS` via `as const`, so the union literally
 * cannot drift from the constants object. Adding a new action is a
 * single edit to `TUG_ACTIONS`; the union updates automatically.
 *
 * Generic on `Extra extends string` so non-production consumers
 * (galleries, demos, tests) can opt into additional action names
 * without polluting the production vocabulary's autocomplete. The
 * default is `never`, so bare `TugAction` is the production-only set.
 *
 * Usage:
 *
 * ```ts
 * // Production: bare TugAction — GalleryAction names are NOT in the union.
 * const action: TugAction = TUG_ACTIONS.CUT;       // OK
 * const bad: TugAction = TUG_GALLERY_ACTIONS.PREVIEW_COLOR; // compile error
 *
 * // Gallery opt-in: pass GalleryAction as the Extra parameter.
 * const demo: TugAction<GalleryAction> = TUG_GALLERY_ACTIONS.PREVIEW_COLOR; // OK
 * ```
 *
 * The chain's dispatch and registration APIs are likewise generic on
 * `Extra`, defaulting to `never`. Production call sites see only
 * production names; gallery call sites thread `GalleryAction` (or any
 * other string-literal union) through the type parameter and see
 * their extras alongside the production names.
 */
export type TugAction<Extra extends string = never> =
  | typeof TUG_ACTIONS[keyof typeof TUG_ACTIONS]
  | Extra;

/**
 * Demo / test-only action names. Derived from `TUG_GALLERY_ACTIONS`
 * so the two stay in lockstep. Opt in via `TugAction<GalleryAction>`
 * at the dispatch / registration site.
 */
export type GalleryAction = typeof TUG_GALLERY_ACTIONS[keyof typeof TUG_GALLERY_ACTIONS];

// ---- Payload narrowing — how handlers read `event.value` safely ----
//
// `ActionEvent.value` is typed as `unknown` by design (see the file
// header for the "middle ground" rationale: one action per semantic,
// rich payloads documented per-action above rather than baked into
// the type system). Handlers that read `event.value` need a
// narrowing step before using it. Two patterns are in use across
// the codebase; each fits a different shape of handler.
//
// ### Pattern 1 — form-slot narrowing via `useResponderForm`
//
// This is the dominant pattern. Components built on top of
// `useResponderForm` (every A2.1–A2.7 control: checkbox, switch,
// radio, choice, tab bar, accordion, popup button, slider,
// value-input, text input, textarea) register their handlers
// through typed slots:
//
// ```ts
// useResponderForm({
//   toggle: { [senderId]: (v: boolean) => setChecked(v) },
//   setValueNumber: { [senderId]: (v: number, phase) => setValue(v) },
//   selectValue: { [selectGroupId]: (v: string) => setSelected(v) },
// });
// ```
//
// The hook narrows at the slot boundary (`typeof event.value !==
// "boolean"` / `"string"` / `"number"`, `Array.isArray` for
// string[] slots) and invokes the typed setter only on a match. The
// *setter's type signature is the enforcement mechanism*: consumers
// literally cannot write `(v: unknown) => …`, because the slot's
// declared type forces them to annotate the value parameter with
// the narrowed type. One narrowing point per slot, one typed
// contract at each call site. Consumers never touch `event.value`
// themselves.
//
// This is structurally safer than any ad-hoc narrowing utility and
// should be the default path for any form-style control.
//
// ### Pattern 2 — inline `typeof` gates for direct-dispatch responders
//
// A handful of non-form responders handle actions outside the
// `useResponderForm` abstraction: cards dispatching `setProperty` /
// `addTab`, the editor text-input suite dispatching clipboard
// actions, gallery demos dispatching their preview actions. These
// handlers read `event.value` directly and must guard it inline
// before use:
//
// ```ts
// [TUG_ACTIONS.ADD_TAB]: (event: ActionEvent) => {
//   if (typeof event.value !== "string") return;
//   store.addTab(cardId, event.value);
// },
//
// [TUG_ACTIONS.SET_PROPERTY]: (event: ActionEvent) => {
//   const payload = event.value as
//     | { path: string; value: unknown; source?: string }
//     | undefined;
//   if (!payload || typeof payload.path !== "string") return;
//   store.set(payload.path, payload.value, payload.source ?? "inspector");
// },
// ```
//
// Inline `typeof` for primitives; cast-plus-field-check for
// structured payloads whose shape can't be expressed in `typeof`.
// Both patterns early-return on mismatch so a wrong-shape dispatch
// is a silent no-op rather than a runtime crash.
//
// ### Why no `narrowValue` helper
//
// A Phase A1 proposal added a `narrowValue<T>(event, guard)`
// utility intended to standardize Pattern 2. It was never adopted:
// by the time A2.4 shipped, `useResponderForm` had absorbed
// narrowing into its slot contracts (Pattern 1), and the few
// remaining direct-dispatch handlers found inline `typeof` to be
// shorter than writing a type guard for `narrowValue` to consume.
// The utility was removed in A6 as dead code with zero call sites.
// If per-action payload discriminated unions ever become
// worthwhile, that's the successor — not a handler-level helper.
