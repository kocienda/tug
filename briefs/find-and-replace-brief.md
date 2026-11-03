# Find and Replace in the shared find feature

**Purpose:** The deck's find bar can find but not replace. Replace is wanted wherever the text under the bar is editable: the Text card's document and the CM6 composers of the Session card and the Overview card.

---

## Purpose {#purpose}

The user asked: "What would it take to add *replace* to the general/shared find feature we have in CM6-enabled entry cards, including: the session card, Overview card, and text cards." The sketch that followed found that only one of those surfaces is an editable document under a find bar today, and asked three questions. The user answered all three: the composers are in scope ("of course they are"), the replacement string is remembered across summons the way the option toggles are, and literal-mode escapes like `\n` in the replacement expand.

---

## Evidence {#evidence}

**[F01] The shared find machinery is three layers, and only the engine varies per surface** — `tugdeck/src/lib/find-session.ts` owns the query, options, count, active ordinal and wrap bookkeeping behind a `FindEngineDelegate` of optional methods (`searchDidChange`, `findNext`, `findPrevious`, `matchInfo`, `clear`); `tugdeck/src/components/tugways/tug-find-bar.tsx` is the one bar every host mounts; `tugdeck/src/components/tugways/tug-find-cluster.tsx` is the Case / Word / Grep group and the count chip. A new surface joins find by writing a delegate. **(verified)**

**[F02] Find has three hosts today, and the Overview card is not one of them** — the Session card (`cards/session-card.tsx`, engine `lib/transcript-find-engine.ts`, over the read-only transcript), the Text card (`cards/text-card-find-bar.tsx`, over its CodeMirror document) and the Help card (`document-find-engine.ts`, over rendered DOM). `components/overview/overview-card.tsx` mounts no find bar and registers no find action. **(verified)**

**[F03] Neither composer has a find engine** — `tug-text-editor.tsx`, `tug-message-editor.tsx` and `tug-prompt-entry.tsx` import nothing from `@codemirror/search`; only `tug-text-card-editor.tsx` and `tug-code-view.tsx` do. With the caret in the Session composer, ⌘F opens the transcript's bar (`session-card.tsx` `[TUG_ACTIONS.FIND]` toggles it) and ⌘G / ⇧⌘G in the composer step the transcript's matches (`tug-prompt-entry.tsx` `FIND_NEXT`). **(verified)**

**[F04] The Text card already drives CodeMirror's own search, and the package ships replace** — `tug-text-card-editor.tsx` dispatches `setSearchQuery.of(new SearchQuery({...}))`, steps with `findNext` / `findPrevious`, and counts with `query.getCursor`. `@codemirror/search` 6.7.0 exports `replaceNext` and `replaceAll`; `SearchQuery` takes a `replace` string. `replaceNext` replaces the selected match when the selection is exactly the active match and then moves to the next, otherwise only selects the next match; both commands return false on a read-only state; `replaceAll` lands as one transaction with `userEvent` `input.replace.all`, so one ⌘Z undoes it; in regexp mode `getReplacement` expands `$1`-style groups. **(verified, read from `node_modules/@codemirror/search/dist/index.js`)**

**[F05] The Text card's search seam is a private block of its editor** — `setSearchQueryFn`, `selectMatchFromAnchorFn`, `clearSearchFn`, `getMatchInfoFn` and the find-anchor and landing-flash logic (`tug-text-card-editor.tsx` lines ~1458–1700) are written against `viewRef.current` and exported on `TugTextCardEditorDelegate`. Nothing in them is Text-card specific except the delegate they hang on. **(verified)**

**[F06] The bar's Tab stops are hand-numbered in both hosts' censuses** — the bar declares four consecutive stops from `focusOrderBase` (query 0, options 1, previous 2, next 3). The Text card places them at orders 4–7 with the status strip starting at 8 (`TEXT_CARD_CYCLE_ORDER_LINE_ENDING = 8`); the Session card places them at 8–11 with status at 13 and declares a fixed `SESSION_CYCLE_FIND_STOP_COUNT` for its row grid. Extra stops cannot be appended without renumbering. **(verified)**

**[F07] The find options are a deck-wide setting, and that is the model for remembering a replacement** — `settings-api.ts` reads `dev.tugapp.find` / `options` into every new `FindSession` and writes it back through the session's `onOptionsChanged` hook. The Session card also keeps `lastFindQueryRef` so a re-summoned bar seeds its last query; the Text card's session dies with its bar and seeds only from ⌘E. **(verified)**

**[F08] ⌥⌘F derives cleanly and is unclaimed** — `tuglaws/chord-tiers.md` says a ⌥ twist of ⌘F "has to read as a variant of opening the find bar", records that this is why ⌥⌘F was never taken for Fold, and lists no resident on it. `command-registry.ts` binds `KeyF` only as ⌘F (Find) and ⌃⌘F (Full Screen). CodeMirror's `defaultKeymap`, installed in the composer and the Text card, binds no `Alt-Mod-f`. **(verified)**

**[F09] The menu side is a fixed pattern** — the Find submenu in `tugapp/Sources/MenuBarBuilder.swift` holds four items identified `edit.find`, `edit.findNext`, `edit.findPrevious`, `edit.useSelectionForFind`; each has an `AppDelegate.swift` handler that calls `sendControl("<action-id>")`; the registry row is `routing: "first-responder"`, `mirrored: true`; `host-menu-state.ts` publishes each item's gate from `chain.validateAction`. The help card's shortcut list (`cards/help-content.ts`) names the three find actions. **(verified)**

**[F10] The session's wrap rule would misread a replace** — `FindSession.next()` reports a wrap when the active ordinal does not advance. Replacing the active match removes it, so the following match takes the same ordinal and a replace-then-advance that did not wrap would read as one. **(inference from the code in `find-session.ts`; a unit test with a stub delegate confirms it)**

**[F11] Existing find tests** — unit: `lib/__tests__/find-session.test.ts`, `find-parity.test.ts`, `find-trace.test.ts`, `transcript-find-engine*.test.ts`. App-tests: `at0223-text-card-find-bar`, `at0339-session-find-bar` (red on main for an unrelated reason), `at0403-find-selection`, the `at0494` and `at0605` reveal files, `at0603` / `at0604` walks, `at0760-help-card-find`. **(verified by listing)**

---

## Decisions {#decisions}

**[B01] Replace is a capability of the shared session and bar, carried by any engine that implements it.** `FindEngineDelegate` gains optional `replaceNext` and `replaceAll`; `FindSession` gains a replacement string, `setReplacement`, `replaceNext`, `replaceAll`, and a `canReplace` snapshot bit that is true exactly when the attached engine implements replace and reports itself writable. The transcript and document engines implement neither, so their bars never show a replace row and nothing in them changes. This keeps the one-controller rule of [F01] rather than growing a Text-card-only widget.

**[B02] Every editable CM6 surface shares one search engine.** The Text card's private search block [F05] is lifted into one delegate factory over an `EditorView` (search query, anchor landing, step, count, reveal and flash, replace next, replace all). The Text card editor, the Session composer and the Overview composer all hand it their view; the `TugTextEditor` substrate gains the `@codemirror/search` extension so a composer's view can hold a `SearchQuery` and paint matches. Three copies of the seam [F05] is the alternative, and it is how the count-parity drift between the Text card and the transcript already had to be hunted once.

**[B03] The composers are in scope, and each composer is its own find surface with its own session.** The Session card's transcript session stays what it is [F03]; a second, composer-scoped session serves the prompt entry, and the Overview card gets its first find bar, over its composer. A bar is mounted by the host, docked under the composer's entry shell as the Text card docks its bar above the status strip, and the composer session, like the Text card's, lives with the bar.

**[B04] ⌥⌘F is Find and Replace, and the caret decides the target.** A new action `find-replace`, title "Find and Replace…", `routing: "first-responder"`, mirrored into the Swift Find submenu as a fifth item with the same handler shape [F09]. Derivation per [F08]. With the caret in a composer, ⌥⌘F opens that composer's bar with the replace row showing; in the Text card it opens the document's bar with the row showing; elsewhere in a Session card it is not handled, so the item is disabled, since the transcript cannot be replaced into. ⌘F keeps its meaning everywhere it has one today, which in a Session card is the transcript even from the composer [F03]. A read-only Text card validates `find-replace` false; read-only is pushed state, so the gate cannot go stale the way a selection gate would.

**[B05] The replace row is a second row of the one bar, shown only when `canReplace` and the host asked for it.** A one-line `TugTextEditor` for the replacement text in the entry shell's accessory slot, with two `sm` text buttons, Replace and All. Return in that field is Replace. ⌘F on a bar that has the row keeps the bar and the row; Escape and the ✕ dismiss the whole bar. The replacement text lives in that row's CM6 doc and mirrors into the session the way the query does.

**[B06] The replacement string is remembered deck-wide, beside the option toggles.** A `replacement` value under the `dev.tugapp.find` setting [F07], read into every new session and written through a session hook on change. A re-summoned replace row arrives with the last replacement, selected whole so typing replaces it, matching how the query re-seeds.

**[B07] Replacement text expands escapes in literal mode and groups in grep mode.** CodeMirror's defaults: `\n`, `\t` and `\\` in a literal-mode replacement are unquoted, and `$1`…`$9` and `$&` in grep mode refer to the match. The bar does not pass `literal: true`.

**[B08] Replace has its own wrap rule.** After `replaceNext` the session reports a wrap only when the new ordinal is strictly less than the old one, and never when the count fell to zero [F10]. After `replaceAll` the session clears the active match and republishes the count, which the chip then shows as "No results".

**[B09] The Tab census moves to make room, in both hosts.** The replace row adds three stops after the bar's four: replacement field, Replace, All. The Text card's status-strip orders shift by three and the Session card's find-stop count becomes a function of whether the row is showing [F06]. The tests that enumerate those stops move with them in the same step.

**[B10] One ⌘Z undoes one replace gesture.** Replace is one transaction, Replace All is one transaction, both with CodeMirror's `input.replace` user events, so the Text card's store sees ordinary edits, autosave and the dirty state follow, and nothing special is written for undo.

---

## Open Questions {#open-questions}

- Whether plain ⌘F with the caret in a composer should ever target the composer rather than the transcript. [B04] keeps today's meaning because that is the common path for reaching the transcript, and the composer is reached by ⌥⌘F. If the user wants ⌘F to follow the caret, the Session card's `FIND` handler gains a branch and the Overview card gets ⌘F as well; it changes nothing else in this brief.

---

## Non-goals {#non-goals}

- **Find over the Overview column's posts.** It would be a document-engine host like the Help card and is a different piece of work from a composer's find and replace. The Overview bar this brief adds is the composer's.
- **Replace in the transcript or the Help card.** Nothing to replace into. Their engines stay unchanged and their bars never show the row.
- **A replace-only or "Replace in Selection" form, and a replace history.** Not asked for; the remembered replacement [B06] is a single string.
- **CodeMirror's own search panel.** Its extension is installed for its state and commands only; its panel stays hidden, as the Text card already keeps it.
- **Reversing ⌘F's target in the Session card.** Held as the one open question, not done here.

---

## Exit {#exit}

An arc. The order the work wants:

1. Lift the Text card's CM6 search block into the shared engine [B02] with no behaviour change, and keep the Text card's find tests green on it.
2. Add replace to the session and delegate protocol [B01], [B07], [B08], with unit cases on a stub delegate, and to the shared engine via `replaceNext` / `replaceAll`.
3. Give the bar its replace row [B05] and the remembered replacement [B06]; renumber both hosts' censuses [B09].
4. Add the `find-replace` action, chord, menu item, handler, gate and help line [B04].
5. Mount a composer find bar in the Session card's prompt entry and in the Overview card [B03], on the shared engine, with the substrate carrying the search extension.
6. App-tests: a Text card replace file (replace one, replace all, undo, read-only hides the row, ⌥⌘F from the editor) and a composer file per card; move the stop-enumerating tests.
