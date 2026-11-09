# Text Menu

**Purpose:** The text transforms (case and quote level) are in the Edit menu with nowhere to grow. They need a Text menu of their own, modeled on BBEdit's, and a first set of BBEdit's commands should come with them.

---

## Purpose {#purpose}

The user wants Make Uppercase, Make Lowercase, Quote and Unquote moved "out of the Edit menu to a new Text menu… modeled on the BBEdit example." Not all of BBEdit's Text menu comes over, "at least not yet." The new commands are Educate Quotes, Straighten Quotes, Zap Gremlins, Un/Comment Lines, Un/Comment Block, Add Line Breaks, Remove Line Breaks and Strip Quotes. The four existing commands stay, and Quote / Unquote are renamed **Increase Quote Level** / **Decrease Quote Level**.

---

## Evidence {#evidence}

**[F01] The four existing items are built in the Edit menu with empty key equivalents.** `tugapp/Sources/MenuBarBuilder.swift:386-405` adds Make Uppercase, Make Lowercase, Quote and Unquote as `edit.makeUppercase`, `edit.makeLowercase`, `edit.quoteLines` and `edit.unquoteLines`, each as a chain-action round-trip (`performMakeUppercase` and the rest in `tugapp/Sources/AppDelegate.swift:1652-1673`, which send `make-uppercase` / `quote-lines` and so on). The chords come from the command registry through `applyCommandChords`, not from a Swift literal. **(verified)**

**[F02] The registry owns the chords and the item ids.** `tugdeck/src/components/tugways/command-registry.ts:1688-1749` gives Make Uppercase ⌥⌘U, Make Lowercase ⌥⌘L, Quote ⌘' and Unquote ⇧⌘' (shown as ⌘"). Each entry is first-responder routed, `menuEligible`, `mirrored`, and names its `menuItemId`. **(verified)**

**[F03] Case works in plain inputs; quote level works only in the CM6 editors.** The case pair is handled by `use-text-input-responder.tsx`, `tug-text-editor.tsx` (the prompt) and `tug-text-card-editor.tsx`. The quote pair is handled only by the two CM6 editors, through `quoteLinesSpec` / `unquoteLinesSpec` in `tugdeck/src/components/tugways/editor-quote-lines.ts`. **(verified)**

**[F04] Most of BBEdit's chords for the new commands are already taken.** ⌘/ is Open Command Picker, ⌥⌘/ is Show DevTools (`command-registry.ts:3156-3172`, Maker menu, with `disabledChord: "keep"`), and ⌥⇧⌘E is Equalize All Heights. ⌥⇧⌘\ (BBEdit's Remove Line Breaks) is unbound. `tuglaws/chord-tiers.md:175` and `:267` record ⌥⌘/ Show DevTools as a ratified "wink" next to ⌘/ Command Picker. **(verified)**

**[F05] CM6 already ships the comment commands.** `@codemirror/commands` is a dependency, and its `toggleLineComment` / `toggleBlockComment` read the active language's `commentTokens`. The text card loads per-language packages (`lang-rust`, `lang-python`, …). Markdown declares only a block comment (`<!-- -->`). I have not exercised this in Tug; it is from knowledge of the CM6 API. A unit test over a Markdown and a Rust `EditorState` would confirm it.

**[F06] Old item ids and titles are referenced outside the builder.** `tugapp/TugTests/MenuBarBuilderTests.swift` and `tests/app-test/at0420-case-transforms.test.ts` name `edit.makeUppercase` / `edit.quoteLines`. The action vocabulary in `tugdeck/src/lib/action-vocabulary.ts:240-260` documents the four actions. **(verified)**

---

## Decisions {#decisions}

**[B01] A new top-level Text menu sits between Edit and Session, in this order:**

```
Text
  Make Uppercase            ⌥⌘U
  Make Lowercase            ⌥⌘L
  ─────────
  Un/Comment Lines          ⌥⌘/
  Un/Comment Block
  ─────────
  Add Line Breaks
  Remove Line Breaks
  ─────────
  Educate Quotes
  Straighten Quotes
  ─────────
  Increase Quote Level      ⌘'
  Decrease Quote Level      ⌘"
  Strip Quotes
  ─────────
  Zap Gremlins
```

This is BBEdit's placement (Edit → Text) and BBEdit's relative order of these groups, so someone coming from BBEdit finds things where they expect. Edit loses the case and quote groups. It goes from Select All straight to Copy Last Response.

**[B02] Item ids move to a `text.*` namespace**: `text.makeUppercase`, `text.makeLowercase`, `text.toggleLineComment`, `text.toggleBlockComment`, `text.addLineBreaks`, `text.removeLineBreaks`, `text.educateQuotes`, `text.straightenQuotes`, `text.increaseQuoteLevel`, `text.decreaseQuoteLevel`, `text.stripQuotes`, `text.zapGremlins`. Each registry entry's `menuItemId` changes to match. The id names the menu the item lives in, and keeping `edit.*` would make that false.

**[B03] Quote / Unquote become Increase Quote Level / Decrease Quote Level everywhere**: the menu title, the registry `title`, the action constants and strings (`QUOTE_LINES` → `INCREASE_QUOTE_LEVEL`, `"quote-lines"` → `"increase-quote-level"`, and likewise for the counterpart), and the Swift selectors. With no installs yet, a clean rename costs nothing, and a renamed title over an old action name would be a permanent mismatch. ⌘' and ⇧⌘' don't change.

**[B04] Un/Comment Lines takes ⌥⌘/, and Show DevTools loses its chord.** This is the user's call. Show DevTools is a debug-only Maker item that no longer needs a shortcut, and commenting lines is used many times an hour in a code card. Every editor puts it on the slash key. The ⌥⌘/ entry in `tuglaws/chord-tiers.md` (lines 175 and 267, the DevTools "wink") is rewritten to record the reassignment and its reason. Un/Comment Lines is not a variant of ⌘/ Command Picker in R1's sense either, so the new entry is recorded as a user grant, the same way ⌥⌘U / ⌥⌘L are.

**[B05] No other new command gets a chord in this work.** ⌥⇧⌘\ is free for Remove Line Breaks, but nothing shows it would be used often enough to earn a key. Chords can be granted later through `chord-tiers.md`.

**[B06] Un/Comment Lines and Un/Comment Block use CM6's `toggleLineComment` / `toggleBlockComment`** and follow the active language. When the language has no line comment (Markdown, the prompt), Un/Comment Lines is dimmed rather than falling back to a block comment. Un/Comment Block wraps the selection in the language's block tokens, so `<!-- -->` in Markdown.

**[B07] Add Line Breaks turns the soft wraps in the selected lines into real newlines, at the points where the editor is wrapping them now.** That is BBEdit's meaning: what you see becomes what is stored. **Remove Line Breaks** joins the lines of each selected paragraph with one space and keeps blank lines as paragraph breaks.

**[B08] Educate Quotes and Straighten Quotes convert between straight (`"` `'`) and curly quotes, and in Markdown they skip inline code spans and fenced code blocks.** Curling the quotes inside code would quietly break code the user pasted into a prompt or a `.md` file.

**[B09] Strip Quotes removes every Markdown quote level (`>`) from the lines the selection touches.** It is the third operation in the quote-level group, a spec next to the increase/decrease specs in `editor-quote-lines.ts`. It has nothing to do with the curly/straight conversion. BBEdit's grouping makes that clear, and so does ours.

**[B10] Zap Gremlins runs directly with no dialog, so its title has no ellipsis.** It deletes control characters and zero-width characters (U+200B–U+200D, U+2060, U+FEFF), keeping tab and newline, and replaces non-breaking and other Unicode spaces with a plain space. It acts on the selection, or on the whole document when the selection is empty. BBEdit's options dialog can come later if a fixed set turns out to be wrong.

**[B11] Each command is a single editor transaction, so one undo reverts it.** This matches the existing case and quote pairs.

**[B12] Where the commands are enabled follows the existing pattern.** Every item routes to the first responder with no registry predicate. The case pair stays live in plain text inputs ([F03]). All the new commands, and the quote-level group, are handled only by the two CM6 surfaces, the prompt and the text card. They are dimmed elsewhere and on read-only surfaces.

---

## Non-goals {#non-goals}

- **The rest of BBEdit's Text menu.** That means Text Filters, Text Transforms, Unix commands, Exchange Characters, Change Case…, Shift Left/Right, Hard Wrap…, Reformat, line-number, sort and duplicate tools, Canonize, Text Merge, the Convert/Normalize/Unicode group and Strip Diacriticals. The user's scope is "not all… at least not yet."
- **A Zap Gremlins options dialog.** See [B10].
- **Moving Open Command Picker off ⌘/.** It was considered so Un/Comment Lines could have BBEdit's exact chord. It was rejected: the user put Un/Comment Lines on ⌥⌘/ instead.
- **Chords for the other new commands.** See [B05].
- **The context menu.** This work changes the menu bar. Whether the editors' context menus offer any of these commands is a separate question.

---

## Exit {#exit}

**An arc.** A rough order:

1. Native and registry move: build the Text menu in `MenuBarBuilder.swift` with the four existing items under their `text.*` ids and new titles, apply the [B03] rename across the action vocabulary, registry, editors and `AppDelegate`, and update `MenuBarBuilderTests.swift` and `at0420-case-transforms.test.ts`.
2. Comment commands and the chord move: Un/Comment Lines and Un/Comment Block with ⌥⌘/ taken from Show DevTools, and the rewritten `chord-tiers.md` entry.
3. Line breaks: Add and Remove Line Breaks.
4. Quotes: Educate, Straighten and Strip Quotes. Each is a pure spec over an `EditorState`, unit-tested the same way `editor-quote-lines.test.ts` is.
5. Zap Gremlins.

Steps 3–5 are independent of each other. Each new command adds its native item, registry entry, action, and handler in both CM6 editors together, so no item exists without something to answer it.
