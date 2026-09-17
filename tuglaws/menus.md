# Menus

*The macOS menu bar is a projection of the command registry. One TypeScript table states every user-invocable command — its title, how it dispatches, which menu item it drives, which chords it holds — and the host consumes that table as pushed data: enablement, check marks, dynamic titles, and key equivalents all arrive on one wire. Menu items act by sending control frames back into the web layer, never by mutating web state directly.*

*Cross-references: [commands.md](commands.md) (the registry itself, the two funnels, and [L30] — read that before adding a menu item), [action-naming.md](action-naming.md) (the registry layer above the three-way classification), [responder-chain.md](responder-chain.md) (`validateAction` / `queryActionState`), [app-test-harness.md](app-test-harness.md) (`menuSnapshot` / `menuItemState`), [entity-presentation.md](entity-presentation.md) (what an entity IS, which the context-menu section below says what to DO with). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## The shape

```
command registry ──▶ host-menu-state aggregator ──▶ menuState push ──▶ MenuState cache
                                                                             │
                                                          validateMenuItem(_:) pulls
                                                          applyCommandChords() writes
WKWebView ◀── control frame ◀── NSMenuItem action
```

Two channels, one in each direction:

- **State out** — `tugdeck/src/lib/host-menu-state.ts` projects the deck store, the frontmost card's blocks, and the command registry into one payload; diffs it; coalesces on a microtask; posts to `webkit.messageHandlers.menuState`. `MainWindow` forwards it to `AppDelegate.updateMenuState`, which replaces the cached `MenuState` struct wholesale and then re-sweeps the menu bar's key equivalents.
- **Commands in** — every menu item's selector calls `sendControl(...)`; `dispatchAction` forks a registry command to `dispatchCommand` and everything else to the data-frame handler map. No menu item reaches into web state by any other route.

## The menuState wire contract

Posted by the aggregator; parsed by `AppDelegate`'s `MenuState` struct. **Keep both sides in sync** — they are the two halves of one contract.

```jsonc
{
  "panes": [                       // z-order, topmost first
    { "id": "…", "title": "…", "focused": true,
      "cardCount": 2, "closable": true }
  ],
  "activeCard": {                  // focused pane's active card; null when no panes
    "component": "session",
    "closable": true
  },
  "selectionActive": true,         // a card is selected; false on a deselected deck
  "stackDepth": 2,                 // panes sharing the focused pane's slot
  "session": {                     // null unless the active card is a session card
    "cardId": "…",
    "sessionBound": true,
    "canInterrupt": false,
    "canChangeSettings": true,     // canSubmit — false mid-turn locks Permission Mode
    "permissionMode": "default",   // live metadata ?? persisted ?? "default"
    "hasAssistantMessage": false,
    "hasTurns": false,
    "changesVisible": false,       // drives the Show/Hide Changes verb
    "historyVisible": false
  },
  "file": {                        // null unless the active card is a Text card
    "cardId": "…", "mode": "manual", "dirty": false, "untitled": false,
    "readOnly": false, "hasPath": true, "conflict": false
  },
  "document": { "cardId": "…" },   // a frontmost surface that owns its own zoom
  "edit": {                        // first responder's edit capabilities
    "cut": false, "copy": false, "paste": false, "delete": false,
    "selectAll": false,
    "undo": false, "redo": false,  // focused editor's history depth
    "undoLabel": "", "redoLabel": "",  // menu nouns: "Undo Typing"
    "nativeUndoToken": 0,          // non-zero: native text control focused
    "find": false, "findNext": false, "findPrevious": false
  },
  "commands": {                    // THE mirror — one gate per menu item
    "session.nextTurn": {
      "enabled": true,             // absent → the host's own tier still owns it
      "state": false,              // absent → no check-column participation
      "title": "Hide Changes",     // absent → keep the constructed title
      "chord": { "keyEquivalent": "", "command": true, "option": true }
    }
  },
  "recentDocuments": ["/abs/path", "…"],
  "activeTheme": "brio",
  "openQuickly": true,
  "captureArmed": false            // Keyboard pane recording a chord — host parks every key equivalent until disarm
}
```

### The `commands` block

Keyed by `NSUserInterfaceItemIdentifier`, not by command id: the host already switches on the identifier, so joining on it means the host needs no map of its own.

`chord` is **three-state**, and all three are load-bearing:

| Wire | Meaning |
|---|---|
| key absent | leave the item's constructed key equivalent alone |
| `null` | detach it — the chord falls through to the web view |
| a spec | apply it |

Swift distinguishes the first two by the key's *presence*, since an explicit JSON `null` arrives as `NSNull` and would otherwise read as "absent". Getting that wrong turns every detach into a no-op.

`enabled` is optional for the same reason a chord can move without an enablement moving: an item's chord can be the registry's while its predicate stays the host's. View ▸ Zoom In is the standing case — it reads `window.currentPageZoom`, which is the host's own property — so its gate carries a chord and no verdict.

### Publication discipline

- The deck half comes from the aggregator's own `DeckManager` subscription (wired once at boot in `main.tsx`), plus subscriptions to `cardSessionBindingStore`, `cardTitleStore`, and the keymap registry — every store a gate reads but the deck cannot see.
- The `session` and `file` blocks are published by their cards' menu-state effects, which **subscribe to the stores directly** ([L22]) — publication is a side effect, not a render derivation. Every card publishes unconditionally; the aggregator decides which block rides the payload.
- The `edit` block and the `commands` block are computed in one place, from one chain walk, in the flush. A caller that could refresh one without the other would be able to make them disagree.
- **Undo / Redo stay two-path.** For chain editors (CM6) the items round-trip `undo`/`redo` control frames into the focused editor's own history, with depth-accuracy from `validateAction` and a menu noun from the editor's label registry. For browser-native text controls (`nativeUndoToken` non-zero) the host validates LIVE from `webView.undoManager` and executes the native selectors — the only route to a native input's undo stack — kept card-safe by clearing that stack on every token change.
- **Cut / Paste / Select All / Undo / Redo carry a liveness gate.** The chain's first responder is deliberately sticky: a canvas-background click blurs the editor to body but demotes nothing, so a stale FR would keep answering for a visibly deactivated card. Editing actions require actual keyboard focus. Copy is NOT gated — it must keep working for read-only selections, where the selection lives without DOM focus on the responder.
- **Capability flips inside a focused responder** (an editor's undo depth changing as the user types) don't bump the chain's validation version, by design: typing must never re-render chain-subscribed components. Substrates call `requestMenuStateRefresh()` instead, and the CM6 plugin fires it only when availability or label actually *flips*. Widening that trigger while widening the closure's work is the way to put the whole mirror on the keystroke path.
- The aggregator posts only when the serialized payload changes — wire traffic is proportional to menu-relevant change, not store churn.
- Before the first push, the cache is `MenuState.empty`: every gated item validates disabled and every item shows its **constructed** key equivalent. That is the correct cold-start posture, not a bug — and it is why a rebound chord shows its default for the moment before the frontend's own boot closes the window.

## Validation: the mirror first, then two survivors

All enablement flows through `AppDelegate.validateMenuItem(_:)`, keyed on the item's identifier and reading only the cached `MenuState`. AppKit re-validates on menu open and on key-equivalent dispatch. **Nothing pushes `isEnabled` imperatively** — `autoenablesItems` is on, so a stored `isEnabled` is silently overridden by the validator's permissive default, and every gate must be a validator branch. (Four sites once tried; none of them worked, and all four are validator branches now.)

| Tier | Source | What it covers |
|---|---|---|
| 1 — the registry gate | `menuState.commands[<identifier>]` | Every statically-built item whose command has an answer: enablement, check mark, and dynamic title, all from the one table the frontend dispatches from |
| 2 — host-owned live state | `window.currentPageZoom`, `webView.undoManager` | The View zoom bounds, and Undo / Redo while a native text control is focused. Neither fact is the frontend's to know |
| 3 — host-owned readiness | `frontendReady` | About and Settings each open a card, so both are dark until the frontend has signalled ready. This one cannot be a registry gate *in principle*: before the frontend is ready there is no push, so an item that took its answer from the mirror would be answered by the mirror's absence — which reads as enabled |
| 4 — menu structure | — | The Permission Mode submenu's *parent*, which carries no command. Its contents each have one; the parent gates on the same condition so the submenu dims as a whole |
| 5 — parameterized families | built at rebuild time | Themes, the Window pane list, Open Recent — their items are constructed in `menuNeedsUpdate` with their enablement and marks already set, so they are structurally outside a static mirror |

An item absent from `commands` falls through to whichever tier still owns it, which is what let the migration proceed one item at a time: an entry is mirrored in the same change that deletes its hand-rolled case, so exactly one definition of its enablement is ever live.

The Session menu is **disabled, not hidden** — stable menu bars preserve discoverability. The Maker menu is the deliberate exception: it hides when maker mode is off, because maker mode is a *mode*, not a focus state. Maker mode is not a setting — it is derived from the build profile (on in debug bundles, off in release ones and under the app-test harness), so the menu is present-but-hidden in exactly the builds that were never meant to show it. A hidden menu's chords fall through to the web view unless the item sets `allowsKeyEquivalentWhenHidden`, so the Maker menu's ⌘L / ⌥⌘L / ⇧⌘R / ⌘T reach JS while maker mode is off.

## Chords: four layers, and the menu bar is the outermost

**AppKit resolves a menu item's key equivalent before the web view sees a `keydown` at all.** A chord on a menu item is therefore not "first in the JS order" — it is a layer *above* the JS order entirely, and it preempts every scoped binding regardless of focus. The full resolution order is:

1. **The native menu** — any item carrying the chord, if its menu is visible (or `allowsKeyEquivalentWhenHidden`).
2. **The focus mode** — a floating surface's accelerators.
3. **The responder walk**, innermost first.
4. **The global layer.**

Three consequences, and each of them is a decision rather than a detail:

- **A disabled menu item eats its chord with a beep.** It does not fall through. So dimming an item is never the whole answer: a command whose chord should stay reachable while it is inapplicable must *detach* the chord, not merely dim the item.
- **Promoting a command to a menu item takes its chord out of the JS funnel**, globally and unconditionally, including inside every text surface. Menu placement is a chord decision before it is a discoverability one.
- **A `menuEligible` binding must not share a chord with a scoped binding.** The scoped one is not shadowed, it is dead. `keymapRegistry.lintChordCollisions` is the lint that keeps a promotion from silently taking a chord some card wanted.

`resolveChord(chord)` answers this stack for any chord, with `active` / `shadowedBy` per entry, and the Keyboard Shortcuts card renders from it — which is why `pdf-view.tsx` no longer has to reason about ⌘1–⌘3 by hand.

### Where a key equivalent comes from

Construction-time `keyEquivalent` literals in `buildMenuBar` are **defaults**, not the last word. `applyCommandChords()` sweeps `NSApp.mainMenu` recursively and writes what `commands[<id>].chord` says. Because `tugapp/Sources` contains no `performKeyEquivalent` override, no `NSEvent` monitor, and no `keyDown` override, every native key claim in Tug is an `NSMenuItem` key equivalent — so that sweep is complete coverage of the native side, and nothing can hold a chord the keymap cannot see.

The sweep runs from **two** sites, and the second one is not optional: `updateMenuState(_:)` for the whole tree, and the tail of every `menuNeedsUpdate` rebuild for the menu it just rebuilt. The View, Window pane-list, theme, and Open Recent menus reconstruct their items from construction-time literals, and the push only fires on a *changed* projection — so a rebuild after a rebind would restore the literal and keep it until some unrelated state change came along.

Key-equivalent mutation is **banned inside `validateMenuItem`**: that runs inside AppKit's closed-menu key-equivalent scan, where mutating a key equivalent is undefined.

### The `code` → `keyEquivalent` conversion

`chord-format.ts` owns both alphabets and is the only place either is spelled. The conversion returns the character and the mask **together**, never independently: shifted punctuation resolves to the shifted *character* with `shift` dropped from the mask, because AppKit renders the character it is given. Zoom In is `("+", [.command])`, not `("=", [.command, .shift])` — computing the two apart is exactly how ⌘+ turns into ⇧⌘=.

An untabled code throws in dev and publishes `null` in production, so a bad binding detaches a chord rather than silently mis-assigning one.

### The chord table

<!-- generated:chords — regenerated by menus-doc.test.ts; do not hand-edit -->
| Chord | Command | Title | Claimed at |
|---|---|---|---|
| ⇧⌘G | `find-previous` | Find Previous | JS, global |
| ⇧⌘I | `insert-file` | Insert File… | menu bar (swept) |
| ⇧⌘S | `save-as` | Save As… | menu bar (swept) |
| ⇧⌘T | `next-theme` | Next Theme | menu bar (swept) |
| ⇧⌘Z | `redo` | Redo | JS, global |
| ⌃⇧⌘A | `disclaim-all-changes` | Disclaim All Changes | JS, responder |
| ⌃⇧⌘S | `resize-sidebars-to-fit` | Resize Sidebars to Fit | menu bar (swept) |
| ⌃⇧⌘↑ | `move-in-column:top` | Move Card to Top of Column | menu bar (swept) |
| ⌃⇧⌘↓ | `move-in-column:bottom` | Move Card to Bottom of Column | menu bar (swept) |
| ⌃⌘/ | `toggle-column-split` | Split or Stack Column | menu bar (swept) |
| ⌃⌘1 | `go-to-slot:1` | Go to Slot 1 | menu bar (swept) |
| ⌃⌘2 | `go-to-slot:2` | Go to Slot 2 | menu bar (swept) |
| ⌃⌘3 | `go-to-slot:3` | Go to Slot 3 | menu bar (swept) |
| ⌃⌘4 | `go-to-slot:4` | Go to Slot 4 | menu bar (swept) |
| ⌃⌘5 | `go-to-slot:5` | Go to Slot 5 | menu bar (swept) |
| ⌃⌘6 | `go-to-slot:6` | Go to Slot 6 | menu bar (swept) |
| ⌃⌘A | `claim-all-changes` | Claim All Changes | JS, responder |
| ⌃⌘B | `toggle-bullseye` | Bullseye | menu bar (swept) |
| ⌃⌘C | `toggle-changes-view` | Show Session Changes | JS, global |
| ⌃⌘F | `toggle-full-screen` | Enter Full Screen | menu bar (AppKit's own) |
| ⌃⌘H | `toggle-history-view` | Show Commit History | JS, global |
| ⌃⌘I | `run-slash-command:ai` | AI Settings… | menu bar (swept) |
| ⌃⌘J | `toggle-jots` | Show Jots | menu bar (swept) |
| ⌃⌘K | `show-keyboard-shortcuts` | Keyboard Shortcuts… | menu bar (swept) |
| ⌃⌘L | `toggle-layout` | Show Layout | menu bar (swept) |
| ⌃⌘M | `commit-auto-message` | Generate a Commit Message | JS, responder |
| ⌃⌘O | `toggle-overview` | Show Overview | menu bar (swept) |
| ⌃⌘P | `select-composer-route:prompt` | Prompt Route | JS, global |
| ⌃⌘R | `toggle-arcs` | Show Arcs | menu bar (swept) |
| ⌃⌘S | `toggle-sidebars` | Hide Sidebars | menu bar (swept) |
| ⌃⌘U | `run-slash-command:usage` | Show Usage | menu bar (swept) |
| ⌃⌘W | `toggle-cards` | Show Workspaces | menu bar (swept) |
| ⌃⌘Y | `toggle-session-fold` | Fold Session | menu bar (swept) |
| ⌃⌘[ | `previous-turn` | Previous Turn | menu bar (swept) |
| ⌃⌘] | `next-turn` | Next Turn | menu bar (swept) |
| ⌃⌘{ | `first-turn` | First Turn | menu bar (swept) |
| ⌃⌘} | `last-turn` | Last Turn | menu bar (swept) |
| ⌃⌘← | `toggle-rail:left` | Show Left Rail | menu bar (swept) |
| ⌃⌘↑ | `move-in-column:up` | Move Card Up in Column | menu bar (swept) |
| ⌃⌘→ | `toggle-rail:right` | Show Right Rail | menu bar (swept) |
| ⌃⌘↓ | `move-in-column:down` | Move Card Down in Column | menu bar (swept) |
| ⌃⌥⌘P | `cycle-permission-mode` | Cycle Permission Mode | JS, global |
| ⌘+ | `zoom-in` | Zoom In | menu bar (swept) |
| ⌘, | `show-settings` | Settings… | JS, global |
| ⌘- | `zoom-out` | Zoom Out | menu bar (swept) |
| ⌘. | `cancel-dialog` | Cancel | JS, global |
| ⌘/ | `open-command-picker` | Open Command Picker | menu bar (swept) |
| ⌘0 | `zoom-actual` | Actual Size | menu bar (swept) |
| ⌘1 | `move-to-slot:1` | Move Card to Slot 1 | JS, global |
| ⌘2 | `move-to-slot:2` | Move Card to Slot 2 | JS, global |
| ⌘3 | `move-to-slot:3` | Move Card to Slot 3 | JS, global |
| ⌘4 | `move-to-slot:4` | Move Card to Slot 4 | JS, global |
| ⌘5 | `move-to-slot:5` | Move Card to Slot 5 | JS, global |
| ⌘6 | `move-to-slot:6` | Move Card to Slot 6 | JS, global |
| ⌘7 | `move-to-slot:7` | Move Card to Slot 7 | JS, global |
| ⌘8 | `move-to-slot:8` | Move Card to Slot 8 | JS, global |
| ⌘9 | `move-to-slot:9` | Move Card to Slot 9 | JS, global |
| ⌘= | `zoom-in` | Zoom In | JS, global |
| ⌘A | `select-all` | Select All | menu bar (AppKit's own) |
| ⌘C | `copy` | Copy | menu bar (AppKit's own) |
| ⌘E | `find-selection` | Use Selection for Find | JS, global |
| ⌘F | `find` | Find… | JS, global |
| ⌘G | `find-next` | Find Next | JS, global |
| ⌘H | `hide-application` | Hide Tug | menu bar (AppKit's own) |
| ⌘J | `new-jot` | New Jot | menu bar (swept) |
| ⌘K | `focus-prompt` | Focus Prompt | JS, global |
| ⌘M | `minimize` | Minimize | menu bar (AppKit's own) |
| ⌘Q | `quit-application` | Quit Tug | menu bar (AppKit's own) |
| ⌘R | `reveal-stack` | Reveal Stack | menu bar (swept) |
| ⌘S | `save` | Save… | JS, global |
| ⌘T | `add-card-to-active-pane` | New Card in Active Pane | JS, global |
| ⌘V | `paste` | Paste | menu bar (AppKit's own) |
| ⌘W | `close` | Close | JS, global |
| ⌘X | `cut` | Cut | menu bar (AppKit's own) |
| ⌘Z | `undo` | Undo | JS, global |
| ⌘{ | `previous-tab` | Previous Card | JS, global |
| ⌘} | `next-tab` | Next Card | JS, global |
| ⌥⇥ | `cycle-focus-mode` | Cycle Focus Mode | JS, global |
| ⌥⇧⌘C | `copy-as-plain-text` | Copy as Plain Text | JS, global |
| ⌥⇧⌘V | `paste-as-plain-text` | Paste as Plain Text | JS, global |
| ⌥⌘/ | `show-devtools` | Show DevTools | menu bar (swept) |
| ⌥⌘H | `hide-others` | Hide Others | menu bar (AppKit's own) |
| ⌥⌘L | `make-lowercase` | Make Lowercase | menu bar (swept) |
| ⌥⌘U | `make-uppercase` | Make Uppercase | menu bar (swept) |
| ⌥⌘V | `paste-as-quote` | Paste as Quote | JS, global |
| ⌥⌘W | `close-all` | Close All Tabs | JS, global |
| ⌥⌘[ | `previous-stack-card` | Previous Card in Stack | JS, global |
| ⌥⌘] | `next-stack-card` | Next Card in Stack | JS, global |
| ⌥⌘{ | `nudge-slot:left` | Nudge Card Left | JS, global |
| ⌥⌘} | `nudge-slot:right` | Nudge Card Right | JS, global |
| ⌥⌘← | `focus-card:left` | Focus Card Left | menu bar (swept) |
| ⌥⌘↑ | `focus-card:above` | Focus Card Above | menu bar (swept) |
| ⌥⌘→ | `focus-card:right` | Focus Card Right | menu bar (swept) |
| ⌥⌘↓ | `focus-card:below` | Focus Card Below | menu bar (swept) |
| ⎋ | `cancel-dialog` | Cancel | JS, global |
<!-- /generated:chords -->

Chords the user has rebound are not in this table — it is the *defaults*. Overrides live in tugbank under `dev.tugapp.keymap`, one key per command id holding a JSON binding list; an absent key means the default, and an **empty list** means deliberately unbound, which is a different and durable answer. The host never reads that domain: overrides reach it the same way every other chord does, through the push.

## The command catalog

Every menu item, the command behind it, and where each answer comes from. Generated from the registry — a hand-maintained join is a hand-maintained lie.

### A fallback belongs to the command, never to a door

A command with more than one tier — "ask the key card, and if nothing claims it, do the deck-wide thing" — must spell both tiers out behind its own id, in a `registry` handler. Not in the chord pipeline, not in the menu path.

Every command has several doors: a chord, a menu item, the palette, a control frame. They converge on `dispatchCommand(id)` and nowhere earlier. So a second tier implemented at one door is not a fallback, it is a behavior that one door has and the others do not — and because the routing field still reads `key-card`, nothing about the entry says so.

⌥⇥ (`cycle-focus-mode`) is the case that taught this. It routed `key-card`, and its fallback sat in `responder-chain-provider`'s scoped-action-binding branch, which the global chord path does not reach. The gesture worked on the one card that registers a handler and was dead everywhere else — which was every surface the fallback existed for. The comment above it read "the fallback lives here, at the dispatch site, where it provably runs," which is why it survived a whole phase: it named the failure and asserted it was impossible.

<!-- generated:catalog — regenerated by menus-doc.test.ts; do not hand-edit -->
| Menu item | Command | Routing | Enablement |
|---|---|---|---|
| `app.configureTug` | `configure-tug` | registered handler | host tier |
| `app.hide` | `hide-application` | AppKit performs it | host tier |
| `app.hideOthers` | `hide-others` | AppKit performs it | host tier |
| `app.keyboardShortcuts` | `show-keyboard-shortcuts` | first responder | host tier |
| `app.logout` | `logout` | registered handler | host tier |
| `app.quit` | `quit-application` | AppKit performs it | host tier |
| `app.services` | `services` | AppKit performs it | host tier |
| `app.settings` | `show-settings` | first responder | host tier |
| `app.showAll` | `show-all` | AppKit performs it | host tier |
| `edit.copy` | `copy` | AppKit performs it | registry gate |
| `edit.copyAsPlainText` | `copy-as-plain-text` | first responder | registry gate |
| `edit.copyLastResponse` | `run-slash-command:copy` | key card | registry gate |
| `edit.cut` | `cut` | AppKit performs it | registry gate |
| `edit.delete` | `delete` | AppKit performs it | registry gate |
| `edit.find` | `find` | first responder | registry gate |
| `edit.findNext` | `find-next` | first responder | registry gate |
| `edit.findPrevious` | `find-previous` | first responder | registry gate |
| `edit.makeLowercase` | `make-lowercase` | first responder | registry gate |
| `edit.makeUppercase` | `make-uppercase` | first responder | registry gate |
| `edit.paste` | `paste` | AppKit performs it | registry gate |
| `edit.pasteAsPlainText` | `paste-as-plain-text` | first responder | registry gate |
| `edit.pasteAsQuote` | `paste-as-quote` | first responder | registry gate |
| `edit.redo` | `redo` | first responder | host tier |
| `edit.selectAll` | `select-all` | AppKit performs it | registry gate |
| `edit.undo` | `undo` | first responder | host tier |
| `edit.useSelectionForFind` | `find-selection` | first responder | registry gate |
| `file.closeAllCardTabs` | `close-all` | first responder | registry gate |
| `file.closeCard` | `close` | first responder | registry gate |
| `file.exportTranscript` | `run-slash-command:export` | key card | registry gate |
| `file.newJot` | `new-jot` | first responder | host tier |
| `file.newTextCard` | `new-text-card` | first responder | host tier |
| `file.openFile` | `open-file` | first responder | host tier |
| `file.openQuickly` | `open-quickly` | first responder | registry gate |
| `file.openRecent.clear` | `clear-recent-documents` | first responder | host tier |
| `file.reloadFromDisk` | `reload-from-disk` | first responder | registry gate |
| `file.revertToSaved` | `revert-to-saved` | first responder | registry gate |
| `file.save` | `save` | first responder | registry gate |
| `file.saveACopy` | `save-a-copy` | first responder | registry gate |
| `file.saveAs` | `save-as` | first responder | registry gate |
| `help.shortcuts` | `run-slash-command:help` | key card | registry gate |
| `maker.devTools` | `show-devtools` | first responder | registry gate |
| `maker.galleryCard` | `show-component-gallery` | first responder | host tier |
| `maker.leftRail` | `toggle-rail:left` | first responder | registry gate |
| `maker.newCardInPane` | `add-card-to-active-pane` | first responder | registry gate |
| `maker.reload` | `reload` | registered handler | host tier |
| `maker.rightRail` | `toggle-rail:right` | first responder | registry gate |
| `session.addDir` | `run-slash-command:add-dir` | key card | registry gate |
| `session.agents` | `run-slash-command:agents` | key card | registry gate |
| `session.ai` | `run-slash-command:ai` | key card | registry gate |
| `session.commandPicker` | `open-command-picker` | key card | registry gate |
| `session.commit` | `run-slash-command:commit` | key card | registry gate |
| `session.compact` | `run-slash-command:compact` | key card | registry gate |
| `session.context` | `run-slash-command:context` | key card | registry gate |
| `session.diff` | `run-slash-command:diff` | key card | registry gate |
| `session.firstTurn` | `first-turn` | key card | registry gate |
| `session.focusPrompt` | `focus-prompt` | key card | registry gate |
| `session.fold` | `toggle-session-fold` | key card | registry gate |
| `session.hooks` | `run-slash-command:hooks` | key card | registry gate |
| `session.insertFile` | `insert-file` | first responder | registry gate |
| `session.lastTurn` | `last-turn` | key card | registry gate |
| `session.memory` | `run-slash-command:memory` | key card | registry gate |
| `session.new` | `run-slash-command:clear` | key card | registry gate |
| `session.nextTurn` | `next-turn` | key card | registry gate |
| `session.permissionMode.cycle` | `cycle-permission-mode` | key card | registry gate |
| `session.permissionRules` | `run-slash-command:permissions` | key card | registry gate |
| `session.previousTurn` | `previous-turn` | key card | registry gate |
| `session.rename` | `run-slash-command:rename` | key card | registry gate |
| `session.resume` | `run-slash-command:resume` | key card | registry gate |
| `session.rewind` | `run-slash-command:rewind` | key card | registry gate |
| `session.skills` | `run-slash-command:skills` | key card | registry gate |
| `session.stop` | `interrupt-session` | key card | registry gate |
| `session.toggleChanges` | `toggle-changes-view` | key card | registry gate |
| `session.toggleHistory` | `toggle-history-view` | key card | registry gate |
| `session.unname` | `run-slash-command:unname` | key card | registry gate |
| `session.usage` | `run-slash-command:usage` | key card | registry gate |
| `view.actualSize` | `zoom-actual` | first responder | host tier |
| `view.keyboardFocus` | `cycle-focus-mode` | registered handler | host tier |
| `view.nextKeyboardFocus` | `next-keyboard-focus` | registered handler | host tier |
| `view.nextTheme` | `next-theme` | registered handler | host tier |
| `view.previousKeyboardFocus` | `previous-keyboard-focus` | registered handler | host tier |
| `view.zoomIn` | `zoom-in` | first responder | host tier |
| `view.zoomOut` | `zoom-out` | first responder | host tier |
| `window.bullseye` | `toggle-bullseye` | first responder | registry gate |
| `window.cardWidth.comfy` | `set-pane-width:comfy` | first responder | registry gate |
| `window.cardWidth.slim` | `set-pane-width:slim` | first responder | registry gate |
| `window.cardWidth.wide` | `set-pane-width:wide` | first responder | registry gate |
| `window.columnMoveBottom` | `move-in-column:bottom` | first responder | registry gate |
| `window.columnMoveDown` | `move-in-column:down` | first responder | registry gate |
| `window.columnMoveTop` | `move-in-column:top` | first responder | registry gate |
| `window.columnMoveUp` | `move-in-column:up` | first responder | registry gate |
| `window.columnSplit` | `toggle-column-split` | first responder | registry gate |
| `window.deleteWorkspace` | `delete-space` | first responder | registry gate |
| `window.duplicateWorkspace` | `duplicate-space` | first responder | host tier |
| `window.enterFullScreen` | `toggle-full-screen` | AppKit performs it | host tier |
| `window.focusCardAbove` | `focus-card:above` | first responder | registry gate |
| `window.focusCardBelow` | `focus-card:below` | first responder | registry gate |
| `window.focusCardLeft` | `focus-card:left` | first responder | registry gate |
| `window.focusCardRight` | `focus-card:right` | first responder | registry gate |
| `window.goToSlot.1` | `go-to-slot:1` | first responder | registry gate |
| `window.goToSlot.2` | `go-to-slot:2` | first responder | registry gate |
| `window.goToSlot.3` | `go-to-slot:3` | first responder | registry gate |
| `window.goToSlot.4` | `go-to-slot:4` | first responder | registry gate |
| `window.goToSlot.5` | `go-to-slot:5` | first responder | registry gate |
| `window.goToSlot.6` | `go-to-slot:6` | first responder | registry gate |
| `window.minimize` | `minimize` | AppKit performs it | host tier |
| `window.newWorkspace` | `new-space` | first responder | host tier |
| `window.nextCard` | `next-tab` | first responder | registry gate |
| `window.nextCardInStack` | `next-stack-card` | first responder | registry gate |
| `window.previousCard` | `previous-tab` | first responder | registry gate |
| `window.previousCardInStack` | `previous-stack-card` | first responder | registry gate |
| `window.renameWorkspace` | `rename-space` | first responder | host tier |
| `window.resizeSidebarsToFit` | `resize-sidebars-to-fit` | registered handler | registry gate |
| `window.revealStack` | `reveal-stack` | first responder | registry gate |
| `window.sidebar.cards.left` | `set-sidebar-side:cards:left` | registered handler | registry gate |
| `window.sidebar.cards.right` | `set-sidebar-side:cards:right` | registered handler | registry gate |
| `window.sidebar.cards.show` | `toggle-cards` | registered handler | registry gate |
| `window.sidebar.dashes.left` | `set-sidebar-side:dashes:left` | registered handler | registry gate |
| `window.sidebar.dashes.right` | `set-sidebar-side:dashes:right` | registered handler | registry gate |
| `window.sidebar.dashes.show` | `toggle-arcs` | registered handler | registry gate |
| `window.sidebar.jots.left` | `set-sidebar-side:jots:left` | registered handler | registry gate |
| `window.sidebar.jots.right` | `set-sidebar-side:jots:right` | registered handler | registry gate |
| `window.sidebar.jots.show` | `toggle-jots` | registered handler | registry gate |
| `window.sidebar.layout.left` | `set-sidebar-side:layout:left` | registered handler | registry gate |
| `window.sidebar.layout.right` | `set-sidebar-side:layout:right` | registered handler | registry gate |
| `window.sidebar.layout.show` | `toggle-layout` | registered handler | registry gate |
| `window.sidebar.overview.left` | `set-sidebar-side:overview:left` | registered handler | registry gate |
| `window.sidebar.overview.right` | `set-sidebar-side:overview:right` | registered handler | registry gate |
| `window.sidebar.overview.show` | `toggle-overview` | registered handler | registry gate |
| `window.toggleSidebars` | `toggle-sidebars` | registered handler | registry gate |
| `window.zoom` | `zoom-window` | AppKit performs it | host tier |
<!-- /generated:catalog -->

## Context menus — one entity, one menu

*The rest of this document is about the menu bar, which is a projection of the command registry. A right-click menu is a projection of something else: the **thing under the pointer**. The rule that follows is what stops it being a projection of the surface that happened to draw it.*

A right-click produces exactly one of three menus, and which one is decided by what the press landed on, never by which component owns the pixels:

| The press landed on | The menu |
|---|---|
| an **entity** — an atom, or an annotated run of ink | the entity's items, from `lib/annotator/registry`, above the standard block when the surface has a selection |
| **text** with no entity under it | the standard editing block alone (`text-editing-menu.ts`) |
| **chrome** with neither | the "No Actions" fallback |

Never the native browser menu — it reveals the web implementation.

### The registry states the items; the surface states its facts

`registry.ts` is the only place a kind's item list and its order are written. A surface never states items, and this is the whole of the discipline: a file path offered four items in the transcript and two in the Changes shade for as long as the shade was allowed to write its own list.

What a surface *does* supply is `AnnotationMenuFacts` — the live things a payload cannot carry: which card already holds this session, whether another process has it, whether this commit row folds, whether the surface holds a whole commit record or only a sha. The facts are discriminated by kind, so a kind reads its own and narrows without a cast. Annotated ink and a placed atom pass `{ kind: "none" }` and get the items a payload alone can stand behind.

**An item is offered only where it can be performed.** This is [L31] at the menu layer, and it is the reason the facts exist rather than a flag: a session's *Copy as Atom* is written from its identity record, so a surface holding only an id is not offered it. An item that dispatches into silence is worse than an absent one, because the press looked like it worked.

The two reach each other through one typed action. `useAnnotationMenu` samples the press, asks the registry, and hands back both the items and the handlers a consumer folds into its own responder — so the composer, the transcript, the Overview and the shades run one body of code and cannot drift.

### The order is fixed

```
[ Go to it ]        Open in Editor · Open Diff · Open Image · Show / Resume Session · Show in Finder
────
[ Act on it ]       Show / Hide Detail · Bind · Unbind · Discard · Replay
────
[ Copy it ]         Copy <Noun> · Copy as <Format>
────
[ Send it ]         Insert Atom into Prompt · Insert into Prompt
────
[ Standard block ]  Look Up · Cut · Copy · … · Select All
```

Reading down: reach the thing, act on it, take it, say something about it. A menu that opens with a rule suppresses it — whether an item leads depends on which earlier rows the surface's facts turned on, which the registry cannot know when it marks the rule.

### Copy names its noun

`Copy` alone belongs to the standard block, where the noun is *the selection* and the surface supplies it. An entity menu has no selection to mean, so every copy says what it copies: **Copy Path**, **Copy Link**, **Copy Address**, **Copy Full Hash**, **Copy Session ID**, **Copy Command**.

`Copy as <Format>` is the one other shape and it is reserved for a genuinely different **serialization of one entity** — *Copy as Atom* beside *Copy as Citation*, *Copy Command as Plain Text* beside *Copy Command*. Never a second entity, never a second field.

**The atom copy is not a session's alone; it is what an atom-inserting entity offers.** An entity whose insert mints an atom names it in both directions — *Insert Atom into Prompt* to send it, *Copy as Atom* to take it — and one that inserts as text keeps the plain *Insert into Prompt* and offers no atom copy. A file path, a directory, a URL and a resolvable session say it; a command line, an email address and a bare sha do not, because there the insert is a jot and the label would be a lie the menu tells. Both items read one predicate — `atomSegmentFor` in `lib/annotator/atom-segment.ts` — so a kind promoted to atom-insert later inherits both with no menu edit, and the two can never disagree about what the entity is. Its `null` is also [L31] at the source: a session the ledger cannot resolve has no atom to write, so neither row is offered.

`registry.test.ts` fails on a bare `Copy`, on a kind that offers no copy at all, and on a menu that opens with a rule.

### The standard block appears iff the surface has a selection

A **text surface** — transcript, prose, an editor, an input — appends the standard block below the entity items, so a right-click inside a selection keeps Copy and Select All.

An **object** — a badge, a label, a chip, a row, a tile — omits it entirely. It holds no selection, so Cut, Paste and Select All have nothing to be about. They were once drawn dimmed on the theory that a familiar menu with three dead rows reads better than a short live one; it does not, and the flag that chose between the two shapes gave one kind of object a five-row menu and another a one-row menu on nothing but a call site's opt-in.

The **replace** case is narrower and stays: a kind marked `suppressStandardItems` (both command families) shows its items *instead of* the standard block, because a selection-scoped Copy beside Copy-the-command would copy whatever the surface's selection happened to be.

### A secondary click selects the whole entity

**A press that opens a menu about an entity selects that entity — whole — and paints it. It is a consequence of opening the menu, not an option a call site may omit.** Right-clicking a commit atom, a session chip, a copyable, or an annotation in prose selects **all** of it — the whole path, the whole command, the whole `commit:<8>` pill — before the menu opens. WebKit smart-selects the nearest word inside `sendContextMenuEvent`, ahead of any handler, so the default is a highlight naming a fragment of the thing under a menu whose every item acts on the entity; the mismatch reads as the menu being about the fragment. The registry made every menu about an entity *say* the same thing; this rule is what makes the press *do* the same thing, and it is the annotator's and the atom's alike, not a per-kind or per-surface opinion.

**The press lives in one place: `lib/whole-entity-press`.** It owns both halves — a `mousedown` snapshot of the selection as it stood before WebKit's pick, and the `contextmenu` settle that selects the entity and marks it — and every hook that opens a menu about an entity composes it. `useTextSurfaceContextMenu` is one composer among four: it names the element through `wholeEntityTarget` and calls the press's two halves from the handlers its surfaces attach. `useCommitIdentityMenu`, `useSessionIdentityMenu` and `useCopyableText` bind the press to their claim with **native listeners**, because a commit atom stops React propagation of every pointer gesture on itself and a React `onMouseDown` on the claiming ancestor would never fire. A hook that opens the menu on a press without the primitive is refused by `whole-entity-press-shape.test.ts`; a menu opened from a button — `useArcRowMenu`'s `⋯` — is not a press on an entity and stands outside the rule by name.

**The entity is named separately from the claim.** A History row claims the whole row and its menu is about the commit, so a press on the subject, the stamp or a file lights the row's commit atom — the commit's visible name, and what every item acts on. A receipt claims the atom's own wrapper and names the same pill; a session chip names itself; a copyable names itself.

The one selection it leaves alone is a ranged one the user made that reaches *past* the entity: that selection is about more than this annotation, and the standard block's Copy is still about it.

**A mark that is a box paints itself.** A text highlight reaches the runs it covers and stops, so a pill — a commit atom, a session citation, an arc sigil — lit its label and left its node, its padding and its border at rest, which is the same fragment-under-a-whole-menu mismatch one layer down. The settle marks the element with `data-tug-entity-selected` (`lib/entity-selection-paint`) and `styles/tug-annotation.css` fills the enclosure with the colours the native highlight is already painting the label with. A plain run of ink carries the attribute and takes no rule: the browser had drawn it correctly.

**In chrome, the mark is the whole of the face.** The History shade and a session row are `user-select: none`; a range placed on an entity there stands in the DOM — it intersects the element, so the mark goes on and the pill paints from it — while WebKit renders no text for it, so the native highlight has nothing to paint inside the box. The mark is put on only when the selection actually covers the element, and retires with the range on the next `selectionchange`, so a copyable whose selection settles to nothing takes no mark and leaves none behind.

### What is deliberately not here

- **An arc.** It appears only as a row, `arc-row-menu.tsx` is already its one definition, and a registry keyed by what ink and atoms carry is the wrong home for something no ink ever holds.
- **`CommitShaText`'s single Copy.** The label *is* the clipboard spelling — see [entity-presentation.md](entity-presentation.md#an-atom-labels-itself-a-mention-is-labelled-by-its-sentence). That copy is the object's own, not a short commit menu.
- **Chord hints on entity items.** A copyable's text is unselectable and ⌘C is routed natively to the DOM selection, so a chord hint there would advertise a key that does nothing. Hints belong to the standard block, where they are read from the live binding ([P11]).

## The clipboard exception — native re-dispatch, not a round-trip

The clipboard Edit items (Cut / Copy / Paste / Delete / Select All) do **not** round-trip through a control frame. A control frame is async and leaves the JS clipboard call outside the user gesture, which the browser blocks; and WebKit's native `copy:` / `cut:` / `paste:` already drive the system pasteboard correctly. So each item targets a thin AppDelegate wrapper (`performCopy:` etc.) that re-dispatches its native AppKit selector to the first responder synchronously. Routing through the wrapper — rather than binding the item straight to `copy:` — is what puts **enablement** under the registry gate while leaving the action byte-identical to AppKit's own.

Those five commands appear in the registry with `routing: "native"` and in `NATIVE_LOCKED`: the mechanism could rebind them, the policy says no.

## The identifier namespace

Every `NSMenuItem` — including dynamically built ones — carries a stable `NSUserInterfaceItemIdentifier`, namespaced by menu:

```
app.about        file.newSessionCard      edit.findNext        session.stop
view.theme.<name>  window.pane.<n>        maker.devTools       help.shortcuts
session.permissionMode.<mode>             view.zoomInAlias (hidden ⌘= alias)
```

Rules:

- **Identity never rides the title.** Titles localize and (for dynamic items) carry runtime data; the identifier never does. Tests, the harness, and the registry's `menuItemId` join address items by identifier only.
- Dynamic items mint identifiers at build time (`view.theme.<name>`, `window.pane.<n>` by position, since pane ids are session-random).
- AppKit injects its own identified items (dictation, emoji palette) and may clone the fullscreen item into its managed window-tiling section — uniqueness is guaranteed only within our `<menu>.` namespaces.

The Window menu is special: it is `NSApp.windowsMenu`, so AppKit owns auto-added entries in it. The dynamic pane list is managed as a sectioned slice — remove exactly the `window.pane.*` items, re-insert after the anchor separator — and the menu is **never** wholesale-rebuilt (`removeAllItems()` is forbidden there). Automatic window **tabbing** items are suppressed app-wide via `NSWindow.allowsAutomaticWindowTabbing = false` at launch — Tug navigates by cards and panes, not native NSWindow tabs.

## The theme submenu

Its **membership** is a filesystem scan of `tugdeck/styles/themes/*.css` under the configured source tree, so the submenu is empty without one — genuinely dynamic, and it stays a scan. Its **checkmark** rides the push (`activeTheme`): the frontend changes the theme by paths the host never sees, so a value cached at selection time would go stale, and the host used to re-read tugbank on every menu open — a subprocess read on the path that has to finish before the menu can draw.

## Testing

The harness verbs `menuSnapshot` / `menuItemState` report each item's *validated* enabled state — the snapshot runs the same `NSMenuItemValidation` resolution AppKit uses, after calling each menu's `menuNeedsUpdate` — plus the checkmark `state`, the `keyEquivalent`, and the `modifierMask`.

| Coverage | Where |
|---|---|
| Structure, deck tier, maker gate, session tier | `at0167`–`at0174` |
| The registry gate: enablement, state, and titles from the mirror | `at0180` |
| Native key equivalents derived from the keymap, including a rebuild | `at0181` |
| A user override round trip, through the store and through the pane | `at0182` |

Dynamic items rebuild in `menuNeedsUpdate`; the snapshot calls it, so they are visible without opening a menu by hand.
