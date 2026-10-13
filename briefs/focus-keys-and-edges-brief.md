<!-- brief-skeleton v1 -->

# Focus, keys and the edges: first responder across views, chords, Tab at a card's edge, and what draws over what

**Purpose:** The deck arbitrates focus, chords, menus, undo, clipboard, selection paint and overlays inside one document. With a body per card, macOS has one first responder per window and each body is a view that can be it, a chord typed in a body reaches that body's page first, Tab at the end of a card has nowhere to go, the undo manager the menu validates is the wrong view's, and a popover from a body is clipped to its card. This brief moves the arbiter to the host with the shell as its policy, and rules each edge.

Stage 4 of `briefs/per-card-web-views-program-brief.md`.

---

## Purpose {#purpose}

The user: make first responder "work as it does now, but on a modified/more complex tech base." Everything a user does with the keyboard today keeps working, from any card, with the same chords and the same menus.

---

## Evidence {#evidence}

**[F01] Focus is decided in the shell's JS and the host never hears it.** `FocusManager` (`components/tugways/focus-manager.ts:2596`): `setKeyCard` (`:2685`), `firstResponder` (`:3130`), `place` (`:3192`), `advanceKeyViewFocus` (`:4619`); the responder chain's keydown pipeline (`responder-chain-provider.tsx:1675-1695`: focusWalk, arrowNav, capture, actDispatch, keyViewDelegate, arrowFallback, engineScroll, bubble); the first-responder flip (`deck-manager.ts:4620-4670`) fires will/did deactivate and activate through `lib/card-lifecycle.ts`. The host learns only `menuState.panes[].focused` and `document.cardId` (`MenuState.swift:22, 161-162, 205, 229-231`). Tab never crosses cards today (`focusNext/Previous` wrap in the key card, `focus-manager.ts:2043-2051`). **(verified, read)**

**[F02] Chords are menu key equivalents the page gates, and the page sees them first.** Every host-owned chord is an `NSMenuItem` key equivalent applied from the page's `menuState.commands` (`AppDelegate.swift:1608-1634`); there is no `performKeyEquivalent` or `keyDown` override (`:1586-1591`). AppKit offers a key equivalent to the first-responder view before the menu, and a WKWebView forwards it to its page, which may consume it (`menu-chords-hit-the-js-funnel-first`). JS matching is in `responder-chain-provider.tsx:737` against `command-registry.ts` bindings with routing kinds `first-responder | key-card | target | registry | native` (`:101-112`) and `menuEligible` (`:94`). A chord typed in a body therefore reaches the body's page, then AppKit's menu, then `sendControl` to the shell. **(verified, read; the AppKit order is its documented responder behaviour)**

**[F03] Edit menu items ride the responder chain or one view's undo manager.** Cut, Copy, Paste, Delete, Select All re-send `NSText` selectors to the first responder (`AppDelegate.swift:1415-1441`); Undo and Redo use the native `undo:`/`redo:` when `nativeUndoToken != 0`, validated against `window.editingUndoManager()`, which is the one web view's (`MainWindow.swift:1123-1125`, `AppDelegate.swift:1392-1406, 1823-1950`). Lookup uses `webView.showDefinition(for:at:)` with the page's point (`MainWindow.swift:2014-2047`); dictation targets the page (`:2248`). **(verified, read)**

**[F04] Selection paint, overlays and global state assume one document.** `selection-guard.ts` holds one native selection for the focused card and paints the others into an `inactive-selection` Highlight by reading every card's Range. Popovers, tooltips, menus and dialogs portal into one `CanvasOverlayRoot` (`canvas-overlay-root.tsx`, `tug-popover.tsx:785`, `tug-tooltip.tsx:443`). Keyboard access, focus-ring modality and modifier latch are page-global stores writing root attributes (`keyboard-access-store.ts:94`, `modifier-latch.ts:72`); `data-app-active` is written by the deck manager (`deck-manager.ts:2449`). Card drag is DOM drag over `#deck-container` with a ghost in the document (`card-drag-coordinator.ts:247-715`). **(verified, read)**

**[F05] Theme and zoom are per document.** One `<link data-tug-theme>` set flipped by `sheet.disabled` (`theme-links.ts:54-115`), `data-theme-mode` on the root (`theme-tokens.ts:45`), the canvas color posted to the host (`theme-provider.tsx:81`); zoom is `transform: scale()` on `#deck-container` plus viewport variables (`page-zoom-store.ts:103-117`), applied by the host through `onPageZoomApply` to one view (`MainWindow.swift:954`). **(verified, read)**

---

## Decisions {#decisions}

**[B01] The host is the first-responder arbiter, and the shell is its policy.** The shell keeps `FocusManager` and the flip as the single decision of which card is key; when it flips, it posts `keyCard {cardId | "shell"}` to the host, which calls `makeFirstResponder` on that body view or on the shell view. A body never takes first responder on its own: a pointer-down in a body is reported to the shell (`pointerActivate {cardId, point}`, the activation-click path generalised), the shell runs `transferFocusForActivation`, and the flip follows. Inside a body, the responder chain, `FocusContext`, `setKeyView` and `place` run unchanged over the body's own document; the `getFirstResponderCardId` a body reads is the bridge's mirror of the shell's.

**[B02] A chord the body does not own passes through.** The body page runs the same keydown pipeline over its own registry scope and consumes only bindings routed `first-responder` or `key-card` that resolve inside it; a `menuEligible` chord it does not resolve is left to AppKit, whose menu sends it to the shell as today; a deck-scoped binding that is not a menu item is forwarded on the bus as `card-command {chord}` and the shell dispatches it. The shell's `menuState.commands` gates stay the one source of key equivalents; a body posts its `menuState` to the host, and the host merges the key card's body facts with the shell's for validation.

**[B03] Tab at a card's edge hands focus to the shell.** When a body's `focusNext`/`focusPrevious` would wrap, it posts `focus-exit {direction}` on the bus; the shell's `advanceKeyViewFocus` takes the next stop in deck order, which may be chrome or another body, and the flip follows. The focus ring's `place` in the shell draws over bodies (stage 2 [B03]'s layering), so a ring on a body's edge is the shell's as today.

**[B04] Edit, undo, lookup and dictation follow the first responder.** `editingUndoManager()` returns the first-responder view's `undoManager`; Cut, Copy, Paste, Delete and Select All already reach it through `sendAction`; `showDefinition` and dictation act on the view whose handler asked, found by `message.webView`. The clipboard bridges answer into the asking view. Nothing here needs the shell.

**[B05] Selection paint is WebKit's.** `selection-guard.ts` retires: each body holds its own native selection, and WebKit paints an unfocused view's selection as inactive. Cross-card selection does not exist, by the user's ruling. Copy-as-plain-text, clipboard-origin and the text-selection adapter read their own document's selection, which they already do.

**[B06] Overlays: in-card stays in-card; deck-scope stays in the shell.** A body's tooltips, context menus, the history `TugSheet` and the Changes sheet draw in the body and flip inside its bounds; a body that needs a deck-scope surface (the command picker, an `ask` dialog, the session picker, a confirm) asks the shell on the bus with an anchor rect in window coordinates and the shell draws it over everything. The shell posts `pointerClaim` while such a surface is up. Card drag becomes a host drag: the shell starts it from a tab bar, the host moves the body's container with the pointer and the shell draws the ghost and the drop seams; text dragged out of a body is a system drag, which WebKit already provides.

**[B07] Deck-wide state is `deck-facts`.** Keyboard access, focus-ring modality, modifier latch, `data-app-active`, theme, zoom and the shown workspace are posted by the shell on the bus and applied by every body to its own root; a body loads the same theme link set and flips it on the fact. Zoom is one DEFAULTS value: the shell scales its layout and the rects it posts, and each body applies `writeDeckScale` to its own root; the host's page-zoom path applies to every view.

**[B08] VoiceOver reads in deck order.** The host orders body views in the accessibility hierarchy as the shell's pane order, updated with `placeBodies`; `voiceover-changed` reaches every page.

**[B09] Every path has a test from the harness.** `nativeKey` lands on the first responder, so the harness's key tests drive the real path: a chord in a body that the deck owns reaches the shell; Tab at a card's edge reaches the next stop; Undo validates against the body's manager; Copy from a body lands on the pasteboard; a popover from a body draws in the shell over the next card; the focus ring sits on a body's control. `at0140`, `at0399` and the keyboard files are the gates, migrated to `App.body` as they are touched.

---

## Open Questions {#open-questions}

- **Does WKWebView consume a key equivalent it did not handle in time for the menu to see it?** The page must not `preventDefault` a chord it does not own; if WebKit's asynchronous key handling eats the equivalent before AppKit's menu, the host adds a `performKeyEquivalent` on the body view that forwards unhandled chords to the shell. Read first with the harness.
- **Where does the Layout card's "focus follows" setting apply now?** The shell's policy; unchanged unless the reading says otherwise.

---

## Non-goals {#non-goals}

- **Re-ordering or re-binding any chord.** The vocabulary and the registry stand.
- **A host-level keymap.** The page remains the gate; the host remains the menu.
- **Cross-document Tab inside a card.** A card is one document.

---

## Exit {#exit}

**An arc.** The shape: the arbiter and pointer activation ([B01]); chord pass-through and menu state merge ([B02]); Tab at the edge ([B03]); edit, undo, lookup and dictation ([B04]); selection ([B05]); overlays and drag ([B06]); deck facts, theme and zoom ([B07]); VoiceOver order ([B08]); the harness tests beside each ([B09]). It joins when every keyboard path the asks and the keyboard files cover works from a body on the user's deck.
