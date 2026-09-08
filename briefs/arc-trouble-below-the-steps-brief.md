# The arc's trouble goes below the steps

**Purpose:** An arc's warning and error sentences are painted on the lifecycle line, where they are incompressible and the arc's own reading is not — so `Implementing` elides to `I…` to make room for `2 files also edited on main`. The sentences move below the last step; a tone-colored mark stays on the line.

---

## Purpose {#purpose}

The user, on the Z2 `ARC` placard and the Arcs card, with two screenshots:

> In the Z2 Dash popup and the Arcs card, we show warning/error messages right on the top line. This often causes space issues, when prevents essential information from being visible.
>
> I think we should move this warning message text *below* the last step, and show only a warning/error *icon* on the top line. In the Arcs card, the icon would be visible, but the message text would visible when the arc is expanded.

The Arcs card screenshot shows the whole failure in one row: an arc reading `⚒ I… 6/7 · 2 files also edited on main`. The phase — the one thing the line exists to say — is a single letter and an ellipsis, and the space it gave up went to a fact about somebody's uncommitted work on `main`.

---

## Evidence {#evidence}

**[F01] The trouble clause cannot shrink and the arc's reading can — that is the whole mechanism.** In `tugdeck/src/components/tugways/arc-lifecycle-line.css`, `.tug-arc-lifecycle-fact` is `flex: 0 0 auto; white-space: nowrap` while `.tug-arc-lifecycle-note` (the phase word) is `flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis`. Every other run on the line — the track, the glyph, the fraction, the separator — is also `0 0 auto`. The reading is therefore the *only* elastic run in the flex row, so any width the trouble clause wants is taken from it, down to one character. **(verified — read out of the stylesheet, and reproduced in the user's screenshot as `I…`)**

**[F02] The precedence this encodes is backwards.** `arc-lifecycle-line.tsx`'s own docblock states the intent — "the reading elides first when the line runs out of room" — and describes the line as one clause: "what the arc is doing, then what is in its way." What is in the arc's way is a fact about the *checkout*; what the arc is doing is the arc. The rule as written makes the subordinate clause outbid the subject. **(verified — the docblock says it; the ranking is an inference about intent, not a measurement)**

**[F03] Three facts can apply at once, and at most one is ever painted.** `arcMetaFacts` (`tugdeck/src/lib/arc-meta-facts.ts`) can return `conflicts` (danger), `overlap` (caution), and exactly one of `unverified` (caution) / `verified` (subtle) — three simultaneous entries. `arcTroubleClause` (`arc-lifecycle-line.tsx`) paints `facts[0]` and joins *every* fact's tooltip into that one clause's hover. So today two of three sentences are reachable only by hovering a clause that is about a different fact. **(verified)**

**[F04] The one-clause rule was adopted for width, and width is exactly what a footer does not have.** From the same docblock: "**One trouble clause, never two.** Two of these at rail width pushed the row off its edge, and a reader who sees red hovers it — so every applicable clause's sentence is stacked into the one clause's hover, and nothing is lost by painting one." The constraint named is rail width. **(verified — quoted from the source)**

**[F05] Six components pass `facts`, at nine call sites, and they do not all have somewhere to put a footer.** `arcs-card.tsx` (2), `session-card-telemetry-popovers.tsx` (1), `session-changes/session-changes-arc-lane.tsx` (2), `session-card-transcript.tsx` (2, as `message.stageFacts` / `closingStageNote.stageFacts`), `gallery-arc-lifecycle.tsx` (2). The first three host a list or an expandable detail region; the transcript's two stage notes are single blocks in scrollback with nothing below them. **(verified — `grep` over `tugdeck/src`)**

**[F06] The Arcs card's fold cue is disabled precisely when there are no steps.** `arcs-card.tsx`: `disabled={steps.length === 0}` on the `BlockFoldCue`, with the row comment "An arc with no steps draws the cue disabled — present, never absent, so every row's chevron sits at the same edge." An arc still being briefed or devised therefore has no expandable region at all. **(verified)**

**[F07] The `ARC` placard always renders a list when it has one, and stops at the block when it does not.** `ArcPopoverContent` renders `ArcStepItems` when `steps.length > 0`, else `TaskListItems` when there are tasks, else nothing. So "below the last step" is a well-defined place there whenever a ledger exists. **(verified)**

**[F08] The tone→ink mapping already exists and is shared with the conflict fold.** `.tug-arc-lifecycle-fact[data-tone="danger"]` takes `--tug7-element-tone-icon-normal-danger-rest` and `caution` takes `--tug7-element-tone-icon-normal-caution-rest`. These are *icon* tone tokens already being used for text, which is why the swap to a glyph needs no new colour work. The deck's existing alert glyph vocabulary is `TriangleAlert` (28 uses), `CircleAlert` (11), `CircleCheck` (28). **(verified)**

---

## Decisions {#decisions}

**[B01] The lifecycle line carries a tone-colored mark where it carried a sentence.** One glyph in the trouble clause's slot, tone-derived: `CircleAlert` for `danger`, `TriangleAlert` for `caution`, `CircleCheck` for the `verified`/`subtle` receipt. The `·` separator goes with the words — a mark needs no connective between itself and the fraction. The mark keeps today's tooltip verbatim (every applicable fact's sentence, stacked), so no host loses a reading even where there is nowhere to put the text. This fixes [F01] structurally rather than by tuning: a fixed-size glyph cannot bid for the reading's width no matter what the fact says.

**[B02] The mark is drawn for every fact, including `verified`.** The user's call: *"sure. let's be consistent here."* The alternative — a mark only for `danger` and `caution` — was the sketch's proposal, on the argument that a glyph is an interruption and good news is not one. It is rejected because it makes the mark's *absence* ambiguous: no mark would mean either "nothing to report" or "verified, all fine," and those are different facts. With this decision the slot is always occupied when `arcMetaFacts` returns anything, and the glyph's shape is the reading.

**[B03] The mark is not pressable.** The user's call: *"no."* It was floated as a way to make the collapsed Arcs row self-explaining — click the warning, the row folds open. Rejected: it puts a second gesture on a line that has none today, it does nothing on the hosts with no fold, and the hover already carries the full text.

**[B04] The sentences render below the last step, in full, one per line, each in its own tone.** A new sibling of `ArcStepItems` taking the same `ArcMetaFact[]` — working name `ArcTroubleNotes`. Each note shows the fact's `label`; the path-list `tooltip` stays on hover of that note, because eight paths inline would swallow the placard. This is what the user asked for and it is the half of the change that recovers the information: the line stops trying to hold a sentence, and the sentence gets a full-width row.

**[B05] Every applicable fact is shown in the footer, not just the loudest — [F04]'s one-clause rule is superseded *for the footer only*.** The rule was adopted because two clauses at rail width pushed the row off its edge; below the last step there is no such pressure. So a conflicted + overlapping + unverified arc finally reads all three instead of one-and-a-bubble ([F03]). The rule's real content survives untouched on the line, where the mark is singular and takes the loudest tone.

**[B06] Placement is a per-host opt-in, not a global flip.** The hosts with a list or a detail region below the block — the `ARC` placard, the Arcs card row, the Changes shade's arc row — opt in to the mark-plus-footer, on the terms [B08] sets for each. The transcript's two stage notes and the arc receipt header have nothing below them ([F05]) and keep today's sentence-on-the-line. A global change would silently demote those to hover-only, which is a regression, not a fix.

**[B07] A message makes an arc expandable even with no steps.** The user's call: *"But if there's a message, then the arc should become expandable."* The fold's content is therefore "the steps, the notes, or both," and the cue is disabled only when there is neither — replacing [F06]'s `steps.length === 0` test. This is what keeps [B04] honest for an arc still being briefed or devised: it has a mark on its line, and the mark's text is reachable by the same gesture as everywhere else rather than by hover alone. The sketch's alternative — notes sitting directly under the line when there is no list — was rejected in favour of this, because it would have given one class of arc a different shape.

**[B08] In the Changes shade, the notes are never behind the fold.** The user's call: *"Let's keep this join-related information for the Changes strip in view."* This rejects both placements the question offered — end of the detail region, or beside the documents strip — because both put the notes inside `session-changes-arc-detail`, which a collapsed row does not render at all. What these facts are *about* is the checkout's standing against the base, which is the subject of the join, and Changes is the room where a join is decided. So the shade's arc row draws the mark on its line **and** renders the notes under the block unconditionally, folded or not. The fold-gating in [B04] belongs to the Arcs card and the placard; it is not universal, and the hosts differ because the question "what is in this arc's way" is incidental on one surface and the point of the other.

**[B09] The mark keeps its stacked tooltip on every host, including the ones already showing the footer.** The user's call: *"keep it."* The bubble duplicates what is on screen only when the notes happen to be visible — a collapsed Arcs row is the common case, and there the hover is the whole reading. A mark whose hover came and went with a fold would be a glyph that is sometimes dead, and a reader cannot tell which kind they are pointing at without pointing at it. One mark, one behaviour, everywhere.

---

## Non-goals {#non-goals}

- **Not a change to what `arcMetaFacts` derives.** The four clauses, their wording, their tones and their ranking are all as they are. This work moves where they are painted and how many are painted at once; it does not revisit what is worth saying.
- **Not a change to the line's other runs.** The track, the phase glyph, the reading and the fraction keep their order, their sizes, and the reading's elide-first rule — which stops being harmful the moment the incompressible run beside it is a fixed-width glyph ([F01]).
- **Rejected: making the trouble clause elastic too.** Letting the fact shrink and ellipsize would stop it crushing the reading, but a half-elided warning sentence is worse than no sentence — the reader gets `2 files also edi…` and must hover anyway. The mark is the same hover with none of the width.
- **Rejected: a mark only for danger and caution.** See [B02].
- **Rejected: a pressable mark.** See [B03].
- **Rejected: putting the shade's notes inside its detail region.** See [B08]. Both placements originally proposed — end of the detail, or beside the documents strip — hide the notes on a collapsed row, and the shade is the surface where the fact matters most.

---

## Exit {#exit}

An arc. The work is one derivation, one new small component, one line component, and three hosts, and it lands naturally in that order:

- The tone→glyph mapping as a pure function beside `arcMetaFacts`, so it is a table test rather than a DOM one.
- `ArcTroubleNotes` — the toned sentence list, a sibling of `ArcStepItems` at the same scale.
- `ArcLifecycleLine` grows the placement prop ([B06]); the mark replaces the clause when a host opts in, and the default is unchanged so the transcript's stage notes and the receipt header need no edit at all.
- The three opting hosts, one at a time: the `ARC` placard first (it always has a list, so it is the simplest and it is half the complaint), then the Arcs card row — which is also where [B07]'s "a message makes it expandable" is implemented — then the Changes shade's arc row, which renders its notes unconditionally ([B08]) and so shares no fold logic with the other two.

`gallery-arc-lifecycle.tsx` is the surface to read the result on: it already renders the blocked cases with facts attached, so both faces of the change are visible side by side without driving the app.
