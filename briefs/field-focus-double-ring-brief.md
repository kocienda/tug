<!-- brief-skeleton v1 -->

# A text field's own border never wears the ring's hue

**Purpose:** The Filter Cards field in the Cards card can show two focus strokes at once — an outer ring plus an inner one — and can show an accent-coloured stroke around a live caret. Both contradict `tuglaws/focus-language.md`, and the field's own CSS in `tug-input.css` is where they come from.

---

## Purpose {#purpose}

The report, verbatim: "There's something *deeply wrong* about the focus caret and focus ring work, as can be seen in the *Filter Cards* feature in the Cards sidebar card. I *must not* be able to get an inner and outer focus ring on this component. Bad regression. Clearly goes against `@tuglaws/focus-language.md`, and if it doesn't, then it must."

Two screenshots came with it. In the first, the field has no caret, a thick orange ring offset outside it, and a thin lighter stroke right at its edge. In the second, the field has a blinking caret and a thin orange stroke at its edge.

The law is explicit that focus is one mark. "A blinking caret and a focus ring are mutually exclusive" governs the mode division, and the paint-route section says a granted caret reads as mode-paint-off: caret blinks, no rings anywhere. The element-mark doctrine [D122] retired every second stroke the language ever had, and records three failed attempts at a container mark precisely because two closed rectangles a few pixels apart read as a double ring no matter how they are toned.

---

## Evidence {#evidence}

**[F01] The engine is projecting correctly in every state.** A scratch app-test drove the real Cards card as a sidebar card (Class B, so Keyboard Focus mode engages on arrival) and read computed styles and engine attributes at each step. Parked via Tab: `data-kbf` on `html`, `data-key-view-kbd` on the `<input>`, `document.activeElement` on the key sink, no caret. Caret live after a click: no `data-kbf`, no `data-key-view-kbd` anywhere, `data-key-view` still on the input, `activeElement` is the input. `data-key-within` landed on nothing in any state. The scratch test was deleted after the run. **(verified)**

**[F02] The first screenshot is a parked stop with the pointer over it.** With the ring on the input and the pointer resting on it, the input's computed style was: outline `1.5px solid` in the accent hue at offset `2px` (the ring), **and** border `1px solid oklch(0.75 0.02 256)` with the hover background. That border is `--tug7-element-field-border-normal-plain-hover`, painted by the hover rule in `tug-input.css`. With the pointer elsewhere the border was transparent and only the ring painted. The inner stroke is the hover border. **(verified)**

**[F03] The filter field's "quiet bounds" rule loses to hover on specificity, contrary to its own comment.** `tug-filter-field.css` sets the border transparent at rest with `.tug-filter-field .tug-input.tug-filter-field-input:not(:focus)`, which is (0,4,0), and its comment claims this clears the hover rule's `:not()` chain. The hover rule `.tug-input:hover:not(:disabled):not(:read-only):not(:focus)` is (0,5,0). Hover wins. The comment is wrong. **(verified by reading the selectors and by [F02])**

**[F04] The second screenshot is the field's own focus border in the ring's colour.** With the caret live, the input's computed border was `1px solid oklch(0.755 0.2139 55)`, the resolved value of `--tugx-focus-ring`, and its outline was `none`. The rule is `.tug-input:focus { border-color: var(--tugx-focus-ring) }` in `tug-input.css`. `tug-textarea.css` carries the same rule. **(verified)**

**[F05] The accent focus border predates the mode, and the mode change never reached it.** `4870afb8e` ("Fix field focus ring: quiet when backgrounded, swap hues") deliberately moved the focus border onto the accent axis, when a focused field wore ring and border together and the two were meant to match. `2d8117575` ("paint stands down while a caret is granted") later made the ring vanish under a live caret, and the law was rewritten around that. The border rule was not revisited, so a focused field now shows exactly the stroke the mode stands its ring down to avoid. The `focus-ring.css` body comment still describes "the ring (and field border)" as riding the accent axis together. **(verified from git log and the two files)**

**[F06] The theme already has a key-toned focus border for fields.** `brio.css` defines `--tug7-element-field-border-normal-plain-active` (cobalt, the key family) beside `-rest`, `-hover`, `-disabled`, and `-readonly`. Nothing in `tug-input.css` uses it. **(verified)**

**[F07] The law states the rule but not its consequence for a field's own paint.** `focus-language.md` says a caret-holding editor wears no ring and that the element mark rides Accent while selection rides Key, but it never says that a component's own border may not borrow the accent hue, nor that a stop wearing the ring paints no hover. `focus-ring.css`'s body comment says the opposite. **(verified)**

---

## Decisions {#decisions}

**[B01] The accent hue belongs to the ring alone. A text field's own border never rides `--tugx-focus-ring`, in any state.** The mode stands the ring down under a live caret so that the caret is the only focus mark; a border in the ring's colour puts the ring back under a different property name. The focused field's border moves to the field family's own key-toned token, `--tug7-element-field-border-normal-plain-active` ([F06]), alongside the existing `plain-focus` background shift. This applies to `TugInput` and `TugTextarea` alike. Validation colours on focus (danger, success, caution) are untouched: they are a state, not the affordance hue, and they were never the ring.

**[B02] A stop wearing the ring answers the pointer with nothing.** The hover rule in `tug-input.css` excludes `[data-key-view-kbd]`. A parked field is marked by the ring, and the ring is meant to be the only mark on it; a hover border beside it is the inner ring of the first screenshot ([F02]). This is fixed at the `TugInput` level, not the filter field's, because every ringed field has the same two strokes.

**[B03] The filter field's quiet-bounds rule is made true.** Its selector is raised so it does outrank the hover rule, and its comment says what the cascade actually does ([F03]). A filter field keeps a transparent border at hover and at focus both: its surface carries its bounds, and after [B01] there is no accent border for it to opt out of.

**[B04] The law gains the sentence it is missing.** Under the passage "a caret-holding editor wears no ring" in `focus-language.md`: the accent hue is the ring's alone, no component paints its own border or stroke in it, and a stop wearing the ring paints no hover. The `focus-ring.css` body comment describing the field border as riding the accent axis is rewritten to match, and the `@tug-pairings` tables in `tug-input.css` are updated for the new border token.

**[B05] An app-test pins both halves from computed style.** Extend `at0266-rail-filter` or add a sibling with `@covers` on `tug-input.css` and `tug-filter-field.css`. Parked: the input's outline is the ring and its border colour is transparent. Caret live: the outline is `none` and the border colour is not the resolved `--tugx-focus-ring`. The scratch test in [F01] is the raw material; it read exactly these values.

---

## Non-goals {#non-goals}

- **Changing the engine or the projection.** [F01] shows `computeProjection` and `kbfPainting` doing what the law says. Nothing in `focus-manager.ts` moves.
- **A hover exemption only for the filter field.** Considered and rejected: the two strokes appear on any ringed `TugInput` under the pointer, so the fix belongs to the component ([B02]). The filter-field specificity correction ([B03]) is a second, local bug, not the fix.
- **Retiring the focus background shift.** The `plain-focus` fill is a wash, not a stroke, and the law records that a wash does not read as a ring. It stays.
- **Touching the sheet, alert, popover, and question-dialog stylesheets that reference `--tugx-focus-ring`.** They paint surface-level marks, not a text field's border, and were not examined here. If any of them puts an accent stroke beside a live caret, that is its own finding.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land: the `tug-input.css` and `tug-textarea.css` border change with the pairings tables ([B01]), the hover exclusion ([B02]), the filter-field specificity and comment fix ([B03]); then the app-test ([B05]), run alone and green; then the law and the `focus-ring.css` comment ([B04]), written once the paint has been seen in the real app across a dark and a light theme.
