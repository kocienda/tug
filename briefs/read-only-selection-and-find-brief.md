# Selection and find on read-only documents

**Purpose:** Selection in the transcript and the help documents has regressed: ⌘A does not select the document, and a selection made with the mouse can no longer be extended from the keyboard. The help documents also have no Find, and the glossary and feature guide do not describe Find.

---

## Purpose {#purpose}

The user's report: "selection in the transcript and these other read-only documents has regressed. Can't run select-all. Once I make a selection in the transcript by clicking and dragging with the mouse, I can no longer modify that selection with the keyboard. I used to be able to. Must fix this. I consider this a regression."

And separately: "We should add *find* to the glossary and help." Asked whether the help card itself should get ⌘F: "Yes. Obviously."

This follows `f45798709`, which made help-document prose selectable at all (`help-card.css` opts the body back in to `user-select: text`; `at0758` pins it).

---

## Evidence {#evidence}

**[F01] Select All is natively routed, so ⌘A never reaches the chain.** The registry entry for `TUG_ACTIONS.SELECT_ALL` is `routing: "native"` (`tugdeck/src/components/tugways/command-registry.ts:1568`). The global key funnel returns before dispatch for any native command (`responder-chain-provider.tsx:742`), and the menu item's action sends `NSText.selectAll(_:)` to the key window's first responder (`tugapp/Sources/AppDelegate.swift:1582`). WebKit then selects within whatever holds DOM focus. **(verified, read from the code)**

**[F02] A click in the transcript deliberately leaves DOM focus in the prompt entry.** The transcript renders in a non-interactive list with no focusable element in the click chain, so the composer's caret survives a click on transcript content (`tugdeck/src/components/tugways/cards/transcript-host-helpers.ts`, the comment above `cellProps`). With [F01], ⌘A in a Session card selects within the composer, or nothing in the transcript. The same comment says the cell's first-responder promotion makes "⌘A … route to this entry". Given [F01], that claim is stale. **(verified, read from the code; the user-visible result is inferred and is what the confirming probe measures)**

**[F03] The read-only surfaces' own Select All handlers are reachable only from the context menu.** The transcript cell (`transcript-host-helpers.ts`, `handleSelectAll`) and `TugMarkdownView` (`tug-markdown-view.tsx`, `handleSelectAll` with its virtualized `selectAllActiveRef`) both register `SELECT_ALL` on a responder. Because of [F01], only the right-click menu's targeted dispatch reaches them. **(verified, read from the code)**

**[F04] `TugMarkdownBlock` has no selection or copy behaviour of its own.** The help card renders its document with `TugMarkdownBlock` (`help-card.tsx`). That component registers no responder: no `SELECT_ALL`, no `COPY`, no `useTextSurfaceContextMenu`, no selection extension. `tug-markdown-block.css` carries no `user-select` rule. The help card opts its body in itself since `f45798709`. **(verified, read from the code)**

**[F05] Keyboard extension of a mouse selection goes to the composer.** After a drag in the transcript, DOM focus is still in the composer, a CodeMirror editor ([F02]). Shift+arrow keydown therefore lands in CodeMirror, which moves its own selection. `selection-extension.ts` owns base/extent extension for read-only surfaces, but only for shifted mouse gestures. Nothing extends a read-only selection from the keyboard. **(inferred from the code; the confirming probe measures it)**

**[F06] Since per-card web views, which view gets the keyboard is a host decision.** Every card kind renders in a body web view of its own (`card-registry.ts`, `bodyHandOff` notes). `MainWindow.makeFirstResponder` refuses a body view the shell has not named, unless a click is live inside it (`keyboardNamed`, `liveClickInside`). For the help card, which has no composer, the keyboard may sit on the shell page rather than the body that holds the selection. That would be a second cause for both symptoms there. **(not verified: inference from the code; the probe reads `NSWindow.firstResponder` and `document.activeElement` after a drag)**

**[F07] No test covers either behaviour.** No app-test drives ⌘A or a keyboard extension in the transcript or a read-only document. `at0188` covers transcript copy only, and `at0174` covers Edit-menu validation. Nothing caught the regression, and the commit that introduced it was not found: native routing dates to `d371d7f30` (2026-08-05), and the per-card web view work ([F06], mid-October) is the likelier trigger. **(verified for coverage; the regressing commit is unknown)**

**[F08] Find exists in some surfaces but not the help card, and the documents barely mention it.** The registry has Find, Find Next, Find Previous and Use Selection for Find (`command-registry.ts`, around line 1720). `tug-find-bar.tsx` serves the Session card, the Text card (`text-card-find-bar.tsx`) and the Overview. The help card has none. `docs/glossary.md` has no Find entry. `docs/features.md` mentions transcript find in one line (line 79) and in the shortcut table (line 250). **(verified, read from the code and documents)**

**[F09] The glossary's terms are pinned against the Operator.** `5fd264fd2` added a test that fails when the retrieval prompt's spelled-out term list and the shipped glossary differ, and `help_outline_maps_the_guide_and_the_glossary` (`tugrust/crates/tugcast/src/feeds/operator.rs`) reads the terms back. A new glossary entry moves both. **(verified, read from the landing commit and the test)**

---

## Decisions {#decisions}

**[B01] Confirm the diagnosis before changing the routing.** The first act is a throwaway harness probe under `tugtool file probe`, not committed. In both the transcript and the help card it drags a selection, reads the host's first-responder web view and `document.activeElement`, then presses real ⌘A and ⇧→ and reads the resulting selection. It settles [F05] and [F06] by measurement. The routing fix in [B02]–[B03] is right regardless, but [F06] decides whether host focus also has to change.

**[B02] Select All routes through the responder chain.** `SELECT_ALL` stops being `routing: "native"` and dispatches to the first responder, so a read-only surface answers ⌘A for its own content. Every editable component already registers its own `SELECT_ALL` handler (prompt entry, text editor, input, textarea, value input, code view), so editing fields keep their behaviour. The Edit ▸ Select All menu item takes the same route as the chord, so menu and key cannot disagree. `SELECT_ALL` stays in `NATIVE_LOCKED`: that list locks the binding against user rebinding and is unaffected by the routing change. The stale comment in [F02] is corrected to describe the new route.

**[B03] Selection-extending keys act on the selection, wherever DOM focus is.** When the document selection is a non-collapsed range on a read-only text surface and DOM focus is in an editor elsewhere, the extension chords act on that range through `Selection.modify("extend", …)` and are kept from the editor. The chords are ⇧ with arrows, ⇧⌥ and ⇧⌘ with arrows, and ⇧ with Home/End and Page Up/Down. DOM focus is not moved: the composer keeps its caret and typing still goes there, which is the design [F02] records. The behaviour lives in `selection-extension.ts`, beside the mouse extension it complements, so base/extent and granularity stay one model. Unshifted keys are left alone.

**[B04] Every read-only document shares one selection behaviour.** `TugMarkdownBlock` gains what `TugMarkdownView` has: a responder answering `SELECT_ALL` and `COPY`, the text-surface context menu, and selection extension. It also owns the `user-select: text` opt-in, so a consumer does not have to remember it. The help card inherits all of it. The arc first lists the other read-only surfaces (diff block, PDF text layer, Overview prose, About) and brings in whichever lack the same pieces. "Read-only documents" in the report means all of them, not only the two named.

**[B05] The help card gets ⌘F with the shared find bar.** The help card mounts `tug-find-bar.tsx`, answering Find, Find Next, Find Previous and Use Selection for Find, the way the Session and Text cards do. The guide and glossary are long, and a help card is the one long document in the app with no search.

**[B06] Find is documented in both help documents.** `docs/glossary.md` gains a **Find** entry: ⌘F, ⌘G / ⇧⌘G, ⌘E, and the surfaces Find works in (transcript, Text card, Overview, help cards). `docs/features.md` gains a short Find passage beyond the single line it carries today. The Operator's term list and any pinned outline expectations move with the glossary in the same change ([F09]).

**[B07] Tests on the real key path, red first.** One new app-test file drives the real Tug.app with real key events, not the harness's synthesized `nativeKey`, which hides the JS-funnel-first ordering. It covers: a mouse-drag selection in the transcript extended with ⇧→, ⌘A in the transcript selecting the transcript rather than the composer, ⌘A and ⇧→ in a help card, and ⌘F opening the help card's find bar. Each assertion is shown red with its fix held back by `file probe` before it is accepted green. It carries `@covers` for every file it exercises.

---

## Non-goals {#non-goals}

- **Moving DOM focus into the transcript on click.** It would make native keyboard selection work, but it takes the caret out of the composer on every transcript click. The current design rejected that on purpose ([F02]).
- **Handling ⌘A in the host instead of the deck.** A host-side special case for read-only surfaces would make the menu and the chord two implementations. One chain route serves both ([B02]).
- **Caret browsing or keyboard selection with nothing selected.** The regression is extending an existing selection. Starting a selection from the keyboard in read-only text is new behaviour, not a fix.
- **A find bar for every read-only surface.** Only the help card is added ([B05]). Diff, PDF and the other read-only surfaces keep whatever find they have today.

---

## Exit {#exit}

An arc. The first step is the confirming probe of [B01], whose readings decide whether host first-responder handling joins the fix. Then the chain route for Select All ([B02]), then keyboard extension ([B03]), then `TugMarkdownBlock` parity and the read-only census ([B04]), then the help card's find bar ([B05]). The documentation change ([B06]) can land at any point, together with its Operator pin. The tests of [B07] land with the step each one guards, each shown red first.
