# Find and Replace fixups

**Purpose:** The find-and-replace work landed sound but with gaps. The editor engine cannot observe the editor it searches, Replace and All press silently, several keyboard paths are missing or wrong, and there are a handful of small coherence defects. This brief fixes every one of them.

---

## Purpose {#purpose}

Find and replace landed on `main` as `d7d7f12b4`, with the toolbar and Tab follow-up in `39fba6688`. It has since had a holistic audit against the code and the tuglaws. The audit found no defect that loses text or corrupts undo, but it found the problems listed below, and the user's instruction was: "Write a brief to fix *all* the issues. No bug or deficiency that you mentioned is too small."

So every finding below gets a decision, including the ones the audit first filed as limitations to live with.

---

## Evidence {#evidence}

**[F01] The editor engine never learns that its document changed** — `createEditorFindEngine` (`tugdeck/src/components/tugways/editor-find-engine.ts`) re-reads the match count only when the session asks: on a query change, a step, a replace, or a `refresh()`. Nothing calls `refresh()` when the document is edited. With the bar open on "red" reading "1 of 3", typing another "red" into a composer gives four highlighted matches while the count still reads "1 of 3". The count catches up on the next find gesture. `text-card-find-bar.tsx` has carried a "Parity note: the count refreshes on find actions, not on document edits" since before this work. A composer is a typing surface, so there the gap is the common case, not the edge. **(verified by reading the code; no listener exists on any path)**

**[F02] Writability is derived by hand in three places, and they disagree** — the truth is the view's `EditorState.readOnly`, which the engine's `isWritable` reads. The session only re-reads it when a host pushes a `readOnly` prop that triggers `session.refresh()`:
- `session-card.tsx:5653` pushes `inlineDialogPending || replayHoldActive || drafting`. `drafting` was missing at landing and was added by the audit (`b2615e6c4`), which proves how easy a cause is to miss.
- `overview-card.tsx:2529` pushes `pending`.
- `text-card.tsx:1387` pushes `snapshot.readOnly`.

Separately, `tug-prompt-entry.tsx:3408` gates the ⌥⌘F handler on `!deactivated`, which omits `landingDrafting`. So during an Auto-Message draft, ⌥⌘F opens a bar whose replace row is hidden. [L28] forbids re-deriving a source's state beside the source. **(verified)**

**[F03] Replace and All press silently when there is nothing to replace** — `FindSession.replaceNext` and `replaceAll` return with no effect when the query is empty, and replace nothing when the count is zero. The buttons are enabled in both states. This is the bare-return-on-a-gesture shape [L31] names. **(verified)**

**[F04] ⌘G from the Text card's editor bypasses the shared engine** — `handleFindNext` and `handleFindPrevious` (`tug-text-card-editor.tsx:1896`, `:1902`) call CodeMirror's `findNext` / `findPrevious` directly. That skips the engine's `step`, so a ⌘G from the editor draws no landing ring, does not move the landing anchor, and records no trace gesture. A ⌘G from the bar does all three. **(verified)**

**[F05] The shared engine imports a module private to one card** — `editor-find-engine.ts:65` imports `findRevealFor` from `./tug-text-card-editor/find-reveal`. The landing-reveal rule now belongs to every editable surface, but it lives in the Text card editor's directory. **(verified)**

**[F06] Composer find gestures are traced as the Text card** — the engine writes `surface: "text"` (`editor-find-engine.ts:299`), and `find-trace.ts:72` allows only `"transcript" | "text"`. A trace of a composer search reads as a Text card search. **(verified)**

**[F07] The find bar's CSS header comment is stale** — the header of `tug-find-bar.css` says the toolbar's trailing group holds only the count, the options and ↑ / ↓. Replace and All now end that group. **(verified)**

**[F08] Find sessions are built and seeded in four places** — `composer-find-bar.tsx:99`, `text-card-find-bar.tsx:126`, `session-card.tsx:1712` and `help-card.tsx:164` each construct a `FindSession`, each with its own copy of the seeding: read options from tugbank, wire `putFindOptions`, and for the replace-capable two also read and persist the replacement. **(verified)**

**[F09] `documentFindEngine` is now a forwarding shim** — in `text-card-find-bar.tsx` it rebuilds every delegate method as `engine()?.method?.(…)` over the editor's own engine. It exists only so that a remounted editor is reached through its new engine. **(verified)**

**[F10] ⌘G in a Session composer steps the transcript even when the composer's bar is open** — `tug-prompt-entry.tsx:3392` answers `FIND_NEXT` / `FIND_PREVIOUS` from the transcript's `findSession`. With the composer's own bar open and the caret in the composer, ⌘G walks a search the user is not looking at. From inside the composer bar's fields, ⌘G does step the composer. **(verified)**

**[F11] Replace and Replace All have no keyboard path** — neither is a registry command, so neither has a chord, a menu item, a tooltip naming a chord, or a row in the keymap pane. Return in the replacement field is Replace. Replace All is reachable from the keyboard only by ⌥⇥ cycling to its button. **(verified)**

**[F12] Tab does nothing in a find bar with no replace row** — the query field's high-precedence Tab binding (`39fba6688`) moves to the replacement field, or does nothing when there is none. In the transcript and Help bars, and in a Text card bar opened by ⌘F, Tab is now a dead key. Before `39fba6688` it typed a tab into the query, which was worse. A dead key is still an [L31] silence. With the caret in the field, the bar's other controls are unreachable from the keyboard except through ⌥⇥. **(verified)**

**[F13] A backslash in the query means different things on different surfaces** — the editor engine builds its `SearchQuery` without `literal: true`, and CodeMirror 6.7.0 unquotes the search string when `literal` is off (`index.js:558`, `unquote`). So in a Text card or a composer, the query `\n` matches a newline. The transcript and Help engines escape the query to a literal (`transcript-search.ts:63`, `escapeRegExp`), so there `\n` matches the two characters. CodeMirror uses the one `literal` flag for both the search and the replacement (`index.js:662`, `getReplacement` → `unquote`), so turning it on would also kill the replacement escapes that [B07] of the find-and-replace brief decided. **(verified, read from `node_modules/@codemirror/search/dist/index.js`)**

**[F14] A replacement typed within 400 ms of quitting is lost** — `putFindReplacement` (`settings-api.ts:1180`) debounces its write by `FIND_REPLACEMENT_PUT_DELAY_MS = 400`, and nothing flushes the pending value at teardown. The teardown core already flushes one debounced write of this kind synchronously (`teardown.ts:132`, `flushPromptHistorySync`). **(verified)**

**[F15] Free chord seats on G** — `command-registry.ts` binds `KeyG` only as ⌘G (Find Next) and ⇧⌘G (Find Previous). CodeMirror's `searchKeymap` puts go-to-line on `Mod-Alt-g`, but no Tug editor installs `searchKeymap` (only the `search()` state extension). `tuglaws/menus.md` lists no resident on ⌥⌘G or ⌥⇧⌘G. `tuglaws/chord-tiers.md` defines ⇧ as "reverse, widen, or undo" and ⌥ as the variant modifier. **(verified)**

---

## Decisions {#decisions}

**[B01] The editor engine observes the view it searches, and the hosts stop pushing writability.** This fixes [F01] and [F02] together because they have one cause: the engine has no way to watch its editor. The shared engine module ships a small observer extension, installed beside `search()` in every editor it searches: the `TugTextEditor` substrate and `TugTextCardEditor`.

The engine is told of every document change and every change to `EditorState.readOnly` on whatever view it searches, including after that view remounts. On either, it calls the attached session's `refresh()`. Refreshes are coalesced to at most one per frame, so a large file's capped recount is never paid per keystroke. Like every other registration, the subscription returns its release and is released when the engine detaches or is disposed ([L27]).

All three hand-pushed `readOnly` props on the bars, and the effects that forward them, are deleted. A future host gets the right answer without listing its read-only causes. The Text card's "parity note" about stale counts is retired with it.

**[B02] The ⌥⌘F gate in the prompt entry reads the same truth.** The prompt entry answers `FIND_REPLACE` whenever its host gives it `onFindReplace`, and validates it against the composer view's own `readOnly` rather than `!deactivated`. A drafting composer then disables the item instead of opening a find-only bar ([F02]). An app-test with a read-only composer must show the menu item disabled, so the gate is proven to republish when read-only moves.

**[B03] Replace and All are disabled when there is nothing to replace.** Both buttons render disabled while the session has no query or a zero count, read from the session snapshot through the deck's `useSyncExternalStore` door. A disabled control is the visible reason [L31] asks for ([F03]).

When a chord or menu press ([B05]) arrives with nothing to replace, the refusal is shown on the count chip, which already reads "No results": the chip takes a brief attention mark through a DOM attribute and CSS ([L06]). It is never a silent return.

**[B04] Every find step in an editor goes through the shared engine.** The Text card editor's ⌘G and ⇧⌘G call the editor's `findEngine().findNext()` / `findPrevious()` instead of CodeMirror's commands. A step from the editor then draws the landing ring, moves the anchor and records its trace gesture exactly as a step from the bar does ([F04]). The existing `onFindNavigated` refresh stays.

**[B05] Replace and Replace All become registry commands: ⌥⌘G and ⌥⇧⌘G, mirrored into the Find submenu.** Two new actions:
- `find-replace-next`, titled "Replace", on ⌥⌘G.
- `find-replace-all`, titled "Replace All", on ⌥⇧⌘G.

Both are `routing: "first-responder"`, `mirrored: true`, with Swift Find submenu items after Find and Replace…, `AppDelegate` handlers that `sendControl`, `MenuBarBuilderTests` rows, drift-test rows, `menus.md` rows and help-card lines. The derivation goes into `chord-tiers.md` beside ⌥⌘F's ([F15]):
- ⌥⌘G is R1's ⌥ variant of ⌘G Find Next: replace this match and find the next.
- ⌥⇧⌘G widens that variant to every match, ⇧ in its "widen" reading.

They are answered wherever Find Next is answered for a replace-capable bar: by the bar's responder when the caret is in the bar, and by the host that owns the bar otherwise. The gate is focus-granular, as ⌘E's is: enabled where a replace-capable bar is open. A press with nothing to replace refuses visibly per [B03].

The Replace and All buttons wear `TugActionTooltip`s naming their commands, as ↑ / ↓ do. This closes [F11], and Replace All gets a keyboard path that does not need ⌥⇥.

**[B06] ⌘G follows the bar the user opened over the text the caret is in.** With a composer's own find bar open and the caret in that composer, ⌘G / ⇧⌘G step the composer's session ([F10]). With the composer bar closed, ⌘G keeps stepping the transcript, today's meaning. The Overview composer, which has no transcript, steps its own bar's session whenever that bar is open. This is the ⌘G half of the caret-decides rule ⌥⌘F already follows. It does not touch ⌘F's target, which stays the open question it was.

**[B07] Tab in a find field never types a tab and is never dead.** With the replace row showing, Tab and ⇧Tab move between the query and the replacement field, as the user asked and `39fba6688` built. With no row there is no second field ([F12]). There, Tab does what ⌥⇥ followed by Tab does: it engages the host's focus cycle at the query's own stop and advances to the next stop (the options group), and ⇧Tab steps back the same way. Both go through the existing focus-cycle action and the shared advance performer, not a hand-rolled walk. In every bar, Tab now lands somewhere the user can see.

**[B08] The query is literal on every surface; the replacement still expands escapes.** In literal mode the editor engine escapes backslashes in the query before building its `SearchQuery` (each `\` becomes `\\`). CodeMirror's unquote then returns the user's text unchanged, so `\n` in a query means the two characters `\` and `n` in a Text card, a composer, the transcript and Help alike ([F13]). `literal` stays off, so the replacement keeps [B07] of the find-and-replace brief: `\n`, `\t` and `\\` expand in literal mode, and `$1`…`$9` and `$&` in grep mode. Grep mode is untouched: a pattern is a regular expression on every surface already.

The escaping is a pure helper with plain unit tests, including a query and a replacement that both contain backslashes.

**[B09] A pending replacement is written at teardown.** The settings module exposes a synchronous flush for the debounced replacement write, and the teardown core calls it beside `flushPromptHistorySync` ([F14]). A replacement typed just before quit survives the relaunch.

**[B10] One factory builds every find session.** A `createFindSession` in `lib/` reads the deck-wide options, and for a replace-capable host the remembered replacement, then wires both persistence hooks ([F08]). All four hosts call it, the Help card and the Session card's transcript included, passing whether they can replace. The seeding rule then lives once.

**[B11] The Text card hands its session the editor's engine through a stable proxy written once.** Either the editor's engine outlives an editor remount, so the bar can attach it directly, or the shim is replaced by one generic `proxyFindEngine(getEngine)` in the engine module ([F09]). The arc picks whichever the editor's lifetime allows. Either way, the hand-written per-method forwarding in `text-card-find-bar.tsx` goes away.

**[B12] The landing-reveal rule moves beside the shared engine.** `tug-text-card-editor/find-reveal.ts` and its unit tests move next to `editor-find-engine.ts`, and every importer follows ([F05]).

**[B13] The engine is told which surface it is.** `createEditorFindEngine` takes a surface label, and the trace's `surface` union gains `"composer"`. The Text card passes `"text"` and both composers pass `"composer"` ([F06]). Whatever reads the trace and matches on `surface` learns the new value in the same change.

**[B14] The find bar's CSS header says what the toolbar holds.** The header comment in `tug-find-bar.css` names Replace and All as the end of the trailing group, shown while the replace row is ([F07]).

**[B15] Every fix lands with the test that holds it.**
- Unit tests: the escaping helper; the factory's seeding; `FindSession` refreshing when its engine reports a change.
- App-tests, extending `at0778`–`at0780` where a file already owns the surface:
  - a composer count follows typing with the bar open;
  - a drafting or stood-down composer hides the row and disables ⌥⌘F;
  - Replace and All disabled at zero matches;
  - ⌥⌘G and ⌥⇧⌘G through `performMenuItem`;
  - ⌘G stepping a composer's bar;
  - Tab in a no-row bar engaging the cycle;
  - a ⌘G from the Text card's editor drawing the landing ring;
  - `\n` searched literally in a Text card.

The replacement surviving a relaunch is proven where the harness can relaunch.

---

## Open Questions {#open-questions}

- **Should plain ⌘F with the caret in a composer open the composer's bar?** Carried unchanged from the find-and-replace brief. [B06] makes ⌘G follow the caret, which narrows the gap but does not decide this. It needs the user's call, and nothing in this brief depends on the answer.

---

## Non-goals {#non-goals}

- **Turning on `literal: true` for the editor engine's query.** CodeMirror's one flag governs both the search and the replacement ([F13]), so it would silently undo replacement escapes. Escaping the query ourselves ([B08]) keeps both behaviours.
- **Unquoting escapes in the transcript and Help queries instead.** That would make `\n` mean newline in a transcript search, where rows rarely span the newline the user meant, and it changes two engines to match one. The literal query is the common meaning.
- **Making Tab walk the bar's buttons when the replace row shows.** The user asked for Tab to move between the fields. The buttons are reachable by chord ([B05]) and by ⌥⇥.
- **Keeping host-pushed `readOnly` alongside the observer.** Two derivations of one fact is what [F02] is about. The props are deleted, not kept as a fallback.
- **A count refresh on every keystroke in a huge file.** [B01] coalesces to one per frame on top of the existing 5,000-match cap.

---

## Exit {#exit}

An arc. The order the work wants:

1. The engine's observer and the deletion of the pushed `readOnly` props ([B01]), then the prompt entry's ⌥⌘F gate on the same truth ([B02]). Everything that reads `canReplace` or the count rests on this.
2. The session factory ([B10]), the Text card's engine proxy ([B11]), the reveal module's move ([B12]) and the surface label ([B13]): the structural tidying, before new behaviour lands on top of it.
3. The literal query ([B08]) and the teardown flush ([B09]).
4. Disabled Replace and All and the visible refusal ([B03]), then the two registry commands with their chords, menu items, handlers, tooltips and docs ([B05]).
5. Keyboard routing: the editor's ⌘G through the engine ([B04]), ⌘G following the composer's bar ([B06]), and Tab in a no-row bar ([B07]).
6. The CSS header ([B14]) and the app-tests that hold all of it ([B15]).
