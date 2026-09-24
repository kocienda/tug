<!-- brief-skeleton v1 -->

# Arcs card legibility: controls off the eyebrow

**Purpose:** Arc names and session names in the Arcs sidebar card truncate too often to read. The eyebrow line is spending its width on two controls that are not identities, and the names pay for it.

---

## Purpose {#purpose}

The user's words: "arcs appear in a more complete form in the Arcs sidebar card. Right now, the arc names and session names get truncated too often, which is a substantial harm to legibility." The screenshot that came with it shows three rows at the sidebar's width, every one of them with both pills elided: `^arc-card-lifecycle-ha…` beside `tug/svelte-…`, `^session-dot-over…` beside `tug/glossy-fo…`, `^workspace-switch-q…` beside `workspace…`.

Two remedies were proposed in the same breath: move the controls at the right of the top row to the row beneath, and use a smaller font in the Arcs card, leaving the larger size to the Changes shade, where space is not the constraint. The sketch that followed found the first remedy large and free of doctrine, and the second small and in collision with a rule this codebase settled on 2026-09-04. This brief records both findings and the calls made on them.

---

## Evidence {#evidence}

**[F01] Everything that truncates is on line 1, and line 1 carries two non-identities.** `ArcLifecycleBlock` (`tugdeck/src/components/tugways/arc-lifecycle-block.tsx`) renders the eyebrow as arc atom, hairline rule, worker atom, then a `trailing` slot. The Arcs card (`tugdeck/src/components/arcs/arcs-card.tsx`, the `trailing` prop around line 812) fills that slot with `ArcTransportControl` and `BlockFoldCue`, both at `size="xs"` in icon form. Line 2 is `ArcLifecycleLine`, a centred run of track, phase glyph, verb and fraction, and nothing on it elides in practice. **(verified, read from the code and the screenshot)**

**[F02] The width the controls take is roughly eight characters of pill type.** Two xs icon buttons plus the eyebrow's `--tug-space-sm` gaps come to about 50 to 56 px. The pills set their type at the atom register's 13 px, which is about 7 px per character in the sans face. Moving the controls returns about eight characters to the two names. **(estimated from the CSS values, not measured in the app)**

**[F03] The hairline costs the names another forty pixels of nothing.** `.tug-arc-lifecycle-rule` in `arc-lifecycle-block.css` carries `min-width: 24px` and sits between two `--tug-space-sm` gaps. It is a separator, and at the sidebar's width it is charging the names for its minimum. **(verified, read from the CSS)**

**[F04] Both pills elide at once, with no priority between them.** The chip tier's name span is `flex: 0 0 auto; max-width: 100%` (`tug-session-identity.css`), and nothing in the block or the card says which of the two pills gives way first. The screenshot shows both eliding in every row. **(verified from the CSS and the screenshot)**

**[F05] Shrinking the pill font collides with the atom register.** `tugdeck/src/lib/atom-register.ts` decides every atom's font size and height in one table (13 px type, 22 px box) and its header says the register "is not a parameter": a `sm`/`2xs` size prop, then a second `reading` row chosen per call site, were both retired on 2026-09-04 because nothing measured two surfaces against each other. `at0513-atom-surfaces-one-height` measures five surfaces against the one number. A card-scoped `--tugx-atom-font-size` override is exactly the "third place a number can be authored" that file forbids. **(verified, read from the file)**

**[F06] A smaller Arcs-card scale was tried before and reversed.** [D143] recorded the card at a `rail` block size with a `2xs` atom. The block's own doc comment now says that scale made the track "too small to read as a graphic" and that the block is sized at one scale wherever a whole arc is shown. **(verified, read from D143 and the block's header comment)**

**[F07] The font change buys less than the row move.** At 13 px to 12 px the pills lose about eight percent of their width, about three characters across the pair, against the eight the row move returns. The reading line (`--tug-font-size-sm`, fraction at `xs`) does not truncate, so shrinking it buys legibility nothing. **(estimated, same basis as F02)**

**[F08] The eyebrow's right end once held nothing.** [D168], amended 2026-08-27, says the Arcs card's rows carry no `⋯`, "so the eyebrow's right end is the worker's atom and nothing else." [D176] (the fold cue) and [D178] (the transport) filled the slot afterwards. Moving the controls off the eyebrow restores D168's line rather than contradicting it. **(verified, read from the decisions)**

**[F09] Three other hosts fill the same slot and have room.** The Changes shade's arc lane (`session-changes-arc-lane.tsx`, its `trailing` around line 489) puts its verbs menu and pop-out button in the eyebrow; the arc receipt and join receipt blocks use the `row` layout as a header. None of them shows the truncation. **(verified, read from the code)**

**[F10] Tests that pin the surfaces in play.** `at0407-arcs-card` covers the card's row, `at0405-changes-arc-lane` the shade's lane, `at0513-atom-surfaces-one-height` the atom register, and `gallery-arc-lifecycle.tsx` is the block's documented home. **(verified by grep)**

---

## Decisions {#decisions}

**[B01] The Arcs card's transport and fold cue move to line 2, at the row's trailing edge.** The block gains a second, optional slot beside the existing `trailing`, call it `lineTrailing`, and renders line 2 as a flex row of the lifecycle line plus that slot only when a host passes it. The Arcs card passes the transport and the fold cue there, in the same order as today. Hosts that pass nothing get the same DOM they have now. This is the lever that returns most of the width [F02] and it costs no doctrine [F08].

**[B02] The reading stays centred in the width left of the controls.** Line 2's rule since D168 is that the track and its reading are one centred unit. With controls at the trailing edge, the reading centres inside the remaining width and the controls stand in the column the chevron occupies today, so every row's chevron keeps one x-position and the reading keeps its relationship to line 1's centre. Flush-left packing was considered and set aside: it would abandon the centre relationship the line was built on for no width gain, since the controls' column is fixed either way. Revisit if the centred reading looks unmoored beside a right-hand occupant in the real app.

**[B03] The hairline drops to a separator's minimum.** Its `min-width` comes down from 24 px to about 12 px [F03]. It may still stretch when there is room; it may no longer cost a name a character when there is not.

**[B04] The arc pill has priority over the worker pill.** The arc is the row's subject; the worker is who holds it. When both cannot fit, the worker pill elides first, down to a floor that keeps its dot and a few characters, before the arc name loses anything [F04]. The exact floor is the implementer's to set from the real card, not this brief's.

**[B05] The Changes shade, the receipt blocks and the placard do not move.** They keep filling the eyebrow's `trailing` [F09]. The slot in B01 is additive, so this needs no change to those hosts and no per-host layout mode.

**[B06] The atom register is held for this arc.** The row move lands first and is looked at before the font question is reopened [F05] [F06] [F07]. If a smaller pill is still wanted after that, it is an explicit amendment to the register doctrine and a deliberate re-point of `at0513`, recorded as a design decision, never a CSS override scoped to the card. See the open question below.

**[B07] Record the move as a design decision amending D176 and D178 for the Arcs card.** The controls' new seat is the row's second line, and D168's sentence about the eyebrow's right end holds again for the card.

---

## Open Questions {#open-questions}

- **Whether the pill font should shrink at all, once the row move is visible.** The user asked for it; the sketch recommended holding the register and looking first. This cannot be settled from the code because it is a judgment about the result: if eight characters back is enough, the register stays whole; if not, the amendment in B06 is the path, and it changes what gets written (the register table, its header doctrine, `at0513`, and a design decision). Settled by looking at the card after B01 through B04 land.

---

## Non-goals {#non-goals}

- **A third row for the controls.** It breaks the block's promise of two lines for every phase, and it grows every row to gain nothing the second line's trailing edge cannot give.
- **Letting the eyebrow wrap.** Same growth, less predictably, and the arc and worker would land on different lines row by row.
- **Shrinking the reading line.** It does not truncate [F07]; a smaller track was the thing D143's rail scale got wrong [F06].
- **A card-scoped atom font override.** Ruled out by the register's doctrine [F05]. If the font changes, it changes by amendment, not by override.
- **Changing the Changes shade or the receipt headers.** They have room and keep the eyebrow slot [B05].

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. The block grows the `lineTrailing` slot and the line-row wrapper, with the CSS for a centred reading beside a fixed trailing cluster [B01] [B02]. The gallery page shows the new slot.
2. The Arcs card moves the transport and fold cue into it, and the hairline minimum and pill priority land in the card's and block's CSS [B03] [B04].
3. `at0407` is re-read against the new seat; `at0405` and `at0513` are run to confirm the shade and the register are untouched [F10].
4. The design decision is written [B07].

The open question is answered by looking at the result of step 2 in the real app before anything about the font is touched.
