# Markdown preview in the Text card

**Purpose:** The Text card shows a Markdown file only as source. The user wants to read the styled version in the same card, switched by a toggle that works like Safari's Reader button.

---

## Purpose {#purpose}

The user's request:

> I want a way to *preview a styled version of Markdown files in the text card*. […] swapping the order of the line ending and file type popups […] add a new *Preview* button that works much like the reader button in Safari. It's a toggle button that lights when clicked and shows me the preview version. Obviously, editing is disabled when in preview mode. I think we could give this toggle the ⌥⌘P keyboard shortcut.

A Markdown document opened in a Text card is a CodeMirror buffer with syntax tones and the raw syntax in place. There is no way to see it rendered without leaving the card.

---

## Evidence {#evidence}

**[F01] The reading surface already exists.** The Help card renders a whole Markdown document in flow with `TugMarkdownBlock` in static `initialText` mode (`tugdeck/src/components/tugways/cards/help-card.tsx`), and searches it with `documentFindEngine` (`tugdeck/src/components/tugways/document-find-engine.ts`), which implements the shared `FindEngineDelegate` protocol over the rendered DOM. **(verified)**

**[F02] `TugMarkdownBlock` renders `initialText` once.** Its prop doc says later prop changes are ignored and a consumer that needs new content remounts with a fresh React key or uses streaming mode (`tugdeck/src/components/tugways/tug-markdown-block.tsx`). The Help card remounts by `key={doc}`. **(verified)**

**[F03] The status strip's settable cluster is two popups, line ending then file type.** `tugdeck/src/components/tugways/cards/text-card-status-bar.tsx` renders them in that order in `.text-card-status-group--settable`, pushed to the trailing edge; the number cluster holds the leading edge and grows into the gap. They take focus orders `focusOrder` and `focusOrder + 1`, seeded from `TEXT_CARD_CYCLE_ORDER_LINE_ENDING` in `text-card.tsx`. **(verified)**

**[F04] The effective file type is the popup's override over the path's language.** `text-card.tsx` computes `effectiveLanguageId = languageOverrideId ?? languageIdForPath(snapshot.path)`; the override is `useState`, so it is per-card and does not survive a relaunch. **(verified)**

**[F05] The card already has a read-only gate.** `snapshot.readOnly` is passed to `TugTextCardEditor`, gates `FIND_REPLACE`, and sets the attachment strip's `deletable`. The editor's mount identity is held stable across autosave sub-states, per the comment citing [L26] above the render. **(verified)**

**[F06] There is no standalone toggle button.** `tug-push-button.tsx` has no pressed state or `aria-pressed`; the only `aria-pressed` control in `tugways/` is the item inside `TugOptionGroup`. **(verified, by grep)**

**[F07] ⌥⌘P is unbound.** The only `KeyP` bindings in `tugdeck/src/components/tugways/command-registry.ts` are ⌃⌘P (Prompt route) and ⌃⌥⌘P (Cycle Permission Mode). `tuglaws/chord-tiers.md` holds bare ⌘P in reserve for print or a command palette and records ⇧⌘P as freed; it says nothing of ⌥⌘P. **(verified)**

**[F08] The parser keeps source offsets per block.** `BlockMeta` in `tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts` carries start and end character offsets into the source text. Whether those survive to the rendered DOM in a form a scroll mapping could read was not checked.

**[F09] Relative paths have doors on both sides.** The Help card intercepts clicks on relative links; the Text card opens a path through `openAttachmentPath(p, cardId)`, which picks the card kind by what the file is. How `TugMarkdownBlock` resolves a relative image `src` for a document that lives on disk was not checked.

**[F10] App-tests name the strip.** `at0210-text-card-options`, `at0223-text-card-find-bar` and the five `at0212-text-card-manual-save-*` files match on the status strip or line ending. Which of them enumerate the Tab order was not read.

---

## Decisions {#decisions}

**[B01] Preview is the Help card's reading surface over the Text card's buffer.** `TugMarkdownBlock` in static mode, `documentFindEngine` for Find ([F01]). No second Markdown renderer and no new card kind: the user asked to preview "in the text card", and the pipeline that renders every transcript is the one that should render a document.

**[B02] The strip reads `[Preview] [file type ▾] [line ending ▾]`.** The two popups swap, and the Preview toggle sits to the left of the file type, the control that decides whether it exists. The cluster is trailing-anchored ([F03]), so the button appearing or leaving moves nothing else. Tab order follows the visual order: Preview, file type, line ending.

**[B03] The button exists only when the effective file type is Markdown.** It follows `effectiveLanguageId` ([F04]), not the extension, so setting a `.txt` to Markdown offers Preview, and setting a previewed document away from Markdown returns it to the editor. For any other file type the button is absent rather than disabled; a dimmed control on every source file would advertise a feature that file can never have.

**[B04] Preview renders the buffer, not the file on disk.** Unsaved edits are previewed. Because the block renders once ([F02]), each entry into preview is a fresh mount, and a change to the buffer from outside while previewing (an external reload) remounts it.

**[B05] The editor stays mounted under the preview.** Preview is laid over it, never swapped for it, so undo history, selection and the editor's scroll survive the round trip and the mount-identity guarantee in [F05] holds.

**[B06] Preview disables editing and nothing else.** Typing, paste and Replace are off, through the same gate `snapshot.readOnly` uses. Save still works, since a dirty buffer is still dirty. Find stays and searches the rendered text. The line-ending popup is disabled, since changing it is an edit; the file-type popup stays live ([B03]). The caret `L: C:` cell is hidden and the counts stay.

**[B07] Relative links and images resolve against the file's directory.** A link click opens through `openAttachmentPath`, the door the editor's own paths use ([F09]), so a previewed README's links land the same as its source's.

**[B08] The toggle is a real toggle button, lit when on.** It carries `aria-pressed`. Since none exists ([F06]), the work adds a pressed state to `TugPushButton` in preference to a one-item `TugOptionGroup`, which is a group's shape around a single control.

**[B09] The chord is ⌥⌘P, with a View menu row "Show Markdown Preview".** It is free ([F07]), it reads as the ⌥ variant of the reserved print key (Print Preview), and Xcode puts its preview canvas on the same chord. The grant is recorded in `tuglaws/chord-tiers.md` in the same change. The command is scoped to a Text card whose effective file type is Markdown and is disabled elsewhere.

**[B10] Each side remembers its own scroll position.** The first cut does not map the editor's top line to a rendered block. The user agreed to this on 2026-11-15, with the mapping named as the better later answer; [F08] says the raw material for it exists.

**[B11] Preview is per-card state that does not survive a relaunch.** It persists across tab switches and pane visits, the same lifetime as the file-type override ([F04]). The user agreed on 2026-11-15.

**[B12] Preview works on read-only files.** Nothing about it needs write access.

---

## Open Questions {#open-questions}

- How a relative image in a document on disk reaches pixels ([F09]). The answer is in `tugdeck/src/lib/markdown/enhance-img.ts` and the asset projection the Text card already holds; it decides whether [B07]'s image half is wiring or new work.

---

## Non-goals {#non-goals}

- **A side-by-side or live-updating preview.** The request is a toggle like Safari's Reader: one surface at a time. Streaming mode on `TugMarkdownBlock` would make a live pane possible later; nothing here depends on it.
- **Editing in the rendered view.** Preview is read-only by the user's statement.
- **Preview for other file types.** HTML, reStructuredText and the rest are not offered; the button is Markdown's.
- **Scroll-position mapping between source and rendered text.** Deferred by [B10].
- **Persisting preview across relaunch.** Deferred by [B11].
- **`TugMarkdownText` as the renderer.** It styles Markdown with the raw syntax left in place, which is what the editor already shows.

---

## Exit {#exit}

**An arc.** The first steps, roughly in the order they depend on each other:

- A pressed state on `TugPushButton` ([B08]).
- The strip: swap the popups, add the toggle, renumber the focus orders, and move the app-tests that name the strip or count its stops ([B02], [F10]).
- The preview surface over the mounted editor, keyed to remount on entry and on outside change, with the editing gate and the status-strip changes ([B04], [B05], [B06]).
- Find routed to `documentFindEngine` while previewing ([B01]).
- Relative links and images ([B07]), after the open question is read out of the code.
- The command, its ⌥⌘P binding, the View menu row and the `chord-tiers.md` entry ([B09]).
- An app-test for the toggle carrying `@covers` for `text-card.tsx` and `text-card-status-bar.tsx`.
