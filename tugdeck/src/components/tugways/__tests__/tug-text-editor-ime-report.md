# tug-text-editor IME validation gate — report

| Field | Value |
|------|-------|
| Roadmap step | Step 6 of the text-editing-base design record |
| Risk being validated | R01 of the text-editing-base design record, IME composition with atomic widgets |
| Substrate | CodeMirror 6 |
| Spike branch | `text-editing-base` |
| Validation method | Manual, in real WebKit (Tug.app or Safari) |
| Status | _to be filled in_ |
| Performed by | _to be filled in_ |
| Date | _to be filled in_ |

---

## Why this gate exists

CM6's interaction with `atomicRanges` near IME composition is a known soft spot in upstream forum reports. Adopting CM6 as the `tug-text-editor` substrate is a decided risk ([D01] of the text-editing-base design record); this report is the dedicated validation gate where that risk is checked against actual user-visible behavior.

A failure in any scenario below — character drops, selection collapse, or visible glyph corruption — halts the spike pending discussion. A clean pass commits the substrate decision and unblocks Step 7.

## Substrate IME context

What CM6 provides natively:
- `compositionstart` / `compositionend` are owned by CM6's `inputState` machinery; the editor doesn't dispatch transactions for compose-intermediate strings the way a naïve `input`-event listener would.
- `KeyboardEvent.isComposing` is honored by CM6's keymap dispatch. The substrate does not run a registered keybinding while a key event is part of an active composition.

What `tug-text-editor` adds on top:
- `tug-text-editor/keymap.ts:223` — the Enter handler short-circuits when `event.isComposing`, so the configured `submit`/`newline` action does not fire while the IME owns commit.
- `tug-text-editor/completion-extension.ts:626` — the typeahead popup's high-precedence keymap short-circuits when `event.isComposing`, so Enter / Tab / Arrow keys belong to the IME during composition.

What the existing `TugTextEngine` does that `tug-text-editor` does **not** do (yet):
- Maintains a `_composing` flag flipped on `compositionstart` / `compositionend` and a `_compositionJustEnded` latch that's cleared on the next `keyup`. The latch catches WebKit's quirk where the Enter that commits a Japanese kana composition arrives as a `keydown` *after* `compositionend` (with `isComposing === false`); without the latch, that Enter would fire submit.
- Cancels any active typeahead at `compositionstart` and re-detects via microtask after `compositionend`.

The scenarios below are designed to expose any defect that would arise from these missing protections, as well as upstream R01 cases. If a scenario fails because of one of the missing protections rather than upstream R01, it's a one-line fix in `tug-text-editor` rather than a substrate-level halt — record this distinction in the **Notes** column.

## How to run the tests

1. Build / run tugdeck and open the Component Gallery: `bun run dev` then navigate to **Gallery → TextEdit**.
2. Configure a CJK input method on macOS:
   - **Japanese kana**: System Settings → Keyboard → Input Sources → add **Japanese – Romaji** (or Hiragana). Switch with `⌃Space` or the menu-bar input picker.
   - **Chinese pinyin**: System Settings → Keyboard → Input Sources → add **Pinyin – Simplified**.
3. Click into the **TugTextEditor** field on the gallery card to focus it.
4. Run each scenario below. Record observed behavior in the corresponding section. A scenario passes if every numbered observation matches **Expected**.
5. After all five scenarios, fill in the **Decision** section.

> **Tip — atom insertion.** The gallery card's **Insert atom** row inserts a fresh atom of the requested kind (`file`, `command`, `doc`, `image`, `link`) at the current selection. Use these buttons to set up the "before / after / partial-selection over an atom" cases.

> **Tip — Submit handling.** The card's **Return action** toggle is set to **Newline** by default for these scenarios so Return inserts a line break instead of submitting. If you'd rather verify submit round-trip, switch to **Submits** and watch the **Submits** counter increment when you press Return after compose ends.

---

## Scenario 1 — Japanese kana compose mid-line, no atoms adjacent

**Input method:** Japanese (Romaji or Hiragana)

**Setup:**
1. Start with an empty editor.
2. Type ASCII text on either side of where you'll compose, e.g. `hello  world` with the caret between the two spaces.

**Steps:**
1. Compose the kana for "ありがとう" by typing `arigatou` (Romaji input).
2. Press Space (or the IME's commit key) to commit the kana, **without** pressing Return.
3. Note the resulting text and the caret position.
4. Switch the **Return action** toggle to **Submits**, then press Return.
5. Note that the **Submits** counter increments and the editor clears.
6. Press `⌘↑` to recall the just-submitted draft and confirm the kana round-trips.

**Expected:**
- (a) Compose underline appears under the active romaji as you type, on `cm-content`.
- (b) On commit, the romaji is replaced by `ありがとう` and the caret lands immediately after the kana.
- (c) The text on either side (`hello`, `world`, surrounding spaces) is unchanged.
- (d) Return does not fire submit until **after** the IME commits — verify by watching the **Submits** counter while you commit, then pressing Return.
- (e) `⌘↑` restores `hello ありがとう world` exactly.

**Observed:**

- [ ] (a) compose underline visible
- [ ] (b) commit replaces romaji with kana, caret correct
- [ ] (c) surrounding text unchanged
- [ ] (d) submit only fires after commit (no premature submit on commit-Return)
- [ ] (e) `⌘↑` round-trip preserves kana

**Notes:**

_(record exact observed text if it diverges; note any flicker, repaint glitch, or popup-appearance during compose)_

**Verdict:** ☐ pass ☐ fail

---

## Scenario 2 — Japanese kana compose immediately before an atom

**Input method:** Japanese (Romaji or Hiragana)

**Setup:**
1. Start with an empty editor.
2. Click **Insert atom → file** to insert a `main.ts` atom. The editor now contains a single atom (one U+FFFC).
3. Move the caret to the start of the document (`⌘←` or arrow-left).

**Steps:**
1. With the caret immediately *before* the atom, compose `nihongo` to produce 日本語.
2. Watch the compose underline. Confirm the caret stays on its side of the atom — i.e. the underline does not visually merge with or cross the atom.
3. Commit the composition.
4. Note the resulting glyph order and caret position.
5. Press `←` once to confirm cursor motion treats the atom as an atomic step (one keypress moves past the kana, the next moves past the atom).

**Expected:**
- (a) Compose underline renders to the left of the atom; no overlap on the atom widget.
- (b) After commit, the document reads `日本語<atom>` and the caret sits between the kana and the atom.
- (c) The atom widget is unchanged — no visual corruption, no double-render, no missing icon.
- (d) `←` after commit moves the caret one kana left (within the kana run), not over the atom.
- (e) Selection state never collapses to a different position than where the user is composing.

**Observed:**

- [ ] (a) underline correctly placed before atom
- [ ] (b) glyph order correct after commit
- [ ] (c) atom widget intact
- [ ] (d) cursor motion respects atomicity
- [ ] (e) selection does not collapse during compose

**Notes:**

**Verdict:** ☐ pass ☐ fail

---

## Scenario 3 — Japanese kana compose immediately after an atom

**Input method:** Japanese (Romaji or Hiragana)

**Setup:**
1. Start with an empty editor.
2. Click **Insert atom → command** to insert a `/commit` atom.
3. The caret should already be immediately after the atom; if not, press `⌘→`.

**Steps:**
1. Compose `konnichiwa` to produce こんにちは.
2. Watch the compose underline. Confirm it renders to the right of the atom.
3. Commit the composition.
4. Note the resulting glyph order and caret position.
5. Press `←` once. Caret should move one kana left.
6. Press `←` again. Caret should jump past the atom in one step (atomicity).
7. Press Backspace from end-of-line. The kana should delete one character at a time; one further Backspace at the boundary should delete the entire atom in one stroke.

**Expected:**
- (a) Compose underline renders to the right of the atom; no overlap.
- (b) After commit, the document reads `<atom>こんにちは` with the caret at end of line.
- (c) The atom widget is unchanged.
- (d) Cursor motion respects atomicity (kana characters traversed one at a time; the atom is one step).
- (e) Backspace deletes kana one at a time; the atom deletes as one step.

**Observed:**

- [ ] (a) underline correctly placed after atom
- [ ] (b) glyph order correct after commit
- [ ] (c) atom widget intact
- [ ] (d) cursor motion respects atomicity
- [ ] (e) backspace deletion respects atomicity

**Notes:**

**Verdict:** ☐ pass ☐ fail

---

## Scenario 4 — Chinese pinyin compose with a partial selection over an atom

**Input method:** Chinese (Pinyin – Simplified)

**Setup:**
1. Start with an empty editor.
2. Type ASCII `aa`, then click **Insert atom → doc** to insert a `tuglaws.md` atom, then type ASCII `bb`. The document now reads `aa<atom>bb`.
3. Place the caret between the first `a` and the second `a`. Hold Shift and use `→` (or click-drag) to extend the selection through the atom and the first `b` so the selection covers `a<atom>b` — i.e. the selection straddles the atom.

**Steps:**
1. With the partial-over-atom selection active, begin composing pinyin: type `nihao`.
2. Watch the underline / candidate window. The IME may immediately commit the candidate by replacing the selection — that's expected behavior for any text editor.
3. Pick a candidate (e.g. 你好) and commit.
4. Note the resulting document content and caret position.

**Expected:**
- (a) The IME's candidate window opens and is positioned near the active selection.
- (b) Beginning compose with a ranged selection replaces the selected range with the committed kanji, exactly as it would in any cooperative editor.
- (c) After commit, the document reads `a你好b` — the atom and the surrounding `a`/`b` characters that were inside the selection are gone, replaced by the kanji.
- (d) The caret lands at the end of the inserted kanji (typical IME post-commit position).
- (e) No remnants of the atom widget remain in the DOM (no orphan `<img>` outside the document content).
- (f) Subsequent `⌘Z` undoes the compose-over-selection in a single step (or at most one undo per IME-commit step).

**Observed:**

- [ ] (a) candidate window opens near selection
- [ ] (b) selection replaced cleanly by committed kanji
- [ ] (c) result text correct
- [ ] (d) caret position reasonable
- [ ] (e) no orphan atom DOM
- [ ] (f) undo restores original `aa<atom>bb` in one step

**Notes:**

_(this is the highest-risk scenario per R01 — record any selection collapse, anchored-end drift, or visible glyph corruption with extra detail)_

**Verdict:** ☐ pass ☐ fail

---

## Scenario 5 — Compose-then-undo

**Input method:** either Japanese kana or Chinese pinyin (record which)

**Setup:**
1. Start with an empty editor.
2. Type ASCII `prefix `.

**Steps:**
1. Compose and commit a CJK string (e.g. `arigatou` → ありがとう, or `nihao` → 你好).
2. Type one more ASCII character, e.g. `!`. Document reads `prefix ありがとう!` (or pinyin equivalent).
3. Press `⌘Z` once. Note what reverts.
4. Press `⌘Z` again. Note what reverts.
5. Continue `⌘Z` until the document is empty. Count the keystrokes used.
6. Press `⌘⇧Z` (redo) repeatedly to walk forward. Confirm the document ends back at `prefix ありがとう!`.

**Expected:**
- (a) Each `⌘Z` reverts a coherent unit of input — at most one IME commit per undo step, ASCII typing collapsed into a small number of steps per CM6 history default.
- (b) The IME-committed kanji/kana is treated as a single undoable transaction — undoing it does not leave half-committed romaji on screen.
- (c) Redo walks back forward symmetrically; the final state matches the pre-undo state exactly.

**Observed:**

- [ ] (a) undo steps coherent
- [ ] (b) IME commit undone as one unit
- [ ] (c) redo round-trips to original

**Notes:**

_(record exact undo count from "prefix ありがとう!" to empty, and from empty back; the exact step count is informational, not pass/fail)_

**Verdict:** ☐ pass ☐ fail

---

## Halt conditions

Per the text-editing-base design record's Step 6, the spike halts pending discussion if **any** scenario produces:

- **Character drops** — a CJK character appears mid-compose but vanishes on commit, or the committed string is shorter than the candidate the user picked.
- **Selection collapse** — the editor's selection jumps to a position the user did not place it during or after compose (e.g. caret leaves the compose region; selection range loses its anchor).
- **Visible glyph corruption** — atom widget renders with stale colors / wrong icon / partially clipped, or kana/kanji glyphs render with the wrong codepoint or as `.notdef` boxes that aren't a font-fallback issue.

Cosmetic flicker, candidate-window positioning quirks owned by the OS, and one-frame underline jitter are **not** halt conditions — record under **Notes** and move on.

## Decision

Filled in by the spike owner after running all five scenarios.

| Field | Value |
|------|-------|
| All scenarios pass | ☐ yes ☐ no |
| Halt condition triggered | ☐ no ☐ yes (which: ____) |
| Decision | ☐ continue to Step 7 ☐ halt and discuss |
| Decision date | _____ |
| Decision recorded by | _____ |

**Reasoning:**

_(one to three sentences describing why the decision above was reached, especially if any **Verdict** was `fail` or any **Notes** raised concern)_

## Follow-ups

If the spike continues, capture any non-halting defects observed during validation here so they're not lost. These belong in a small follow-up commit on `text-editing-base` before Step 7 begins or, if scoped, in a tracking item on the text-editing-base design record's roadmap.

- [ ] _e.g. compose-end Enter quirk on WebKit not currently guarded in `tug-text-editor/keymap.ts` (parallels `_compositionJustEnded` in `tug-text-engine.ts`)._
- [ ] _e.g. typeahead trigger detector runs during compose intermediate transactions; consider gating on `view.composing` in `completion-extension.ts`._
