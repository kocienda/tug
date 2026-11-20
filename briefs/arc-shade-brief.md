# The Arc Shade

**Purpose:** Bring the idea → sketch → brief → arc ladder into the Session card as one visible unit of work. The ARC status cell stops opening a popup and instead raises a shade over the transcript that shows the ladder as four cards, the last of which carries what the popup carries today.

---

## Purpose {#purpose}

The "Tug Flows" design study (Tito Ciuro, 2026-11-19) proposes treating idea → sketch → brief → arc as one unit of work and drawing it as four connected cards. The user's response:

> I love this proposal, but I have some notes.
> - I don't want to add the new *Flow* term. The term needs to stay as *Arc*.
> - We *modify Z2* to move Jobs to the left of Arc, which moves to the right to become the rightmost status item. … the Z2 button becomes a *toggle for a new arc tab in the transcript area*.
> - We can't completely eliminate the transcript from view, so maybe the arc tab is really a bottom-originating shade.

and, once the spike had been through four revisions:

> What do we have to do to begin bringing this new arcs behavior online? … The current Arc Z2 popup must move into the arc card on the right.

Today an arc's state is reachable only through a small popup on the ARC cell, and nothing in the Session card shows where an arc came from: the prompt that started it, the conversation that shaped it, or the brief it was opened on.

---

## Evidence {#evidence}

**[F01] The popup is already a component.** `ArcPopoverContent` and `useArcPopoverVerbs` in `tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx` are the popup's content and its verbs (Stop, Changes, Unbind, Replay, Discard, with Discard's confirm). `ArcNonePopoverContent` is the no-arc form. The verbs hook is hosted on the status row and anchors to it. **(verified, by reading)**

**[F02] The Z2 order is STATE, TIME, CONTEXT, ARC, JOBS.** The cells are `SessionTelemetryCell`s in `session-card-telemetry-renderers.tsx` (about lines 1760–1915), each with a `priority` and a `focusOrder` from `cellOrder(n)`; the ARC cell's `onActivate` is `togglePlacard("arc")`. A narrow-width rule reads `data-priority` (about line 1036). **(verified, by reading)**

**[F03] An arc already records its brief.** The arc log's `arc-start` line carries the brief's path (`tugrust/crates/tugarc-core/src/log.rs` fixtures: `live-one  arc-start  arc/live-one-brief.md`). **(verified, by reading)**

**[F04] Nothing records an idea or a sketch.** No fact was found that says which session or turns a brief was written from, or that a session with no arc has written a brief. This is from searching `tugarc-core` and `tugdeck/src/lib` for brief linkage; it is an absence, so it is as strong as the search. **(searched, not exhaustive)**

**[F05] `^` already means "the arc named…".** `ARC_SIGIL` in `tugdeck/src/lib/arc-sigil-text.ts`, rendered by `arc-sigil.tsx`, as in `^vids-python-to-swift`. **(verified, by reading)**

**[F06] The spike models the approved behaviour.** `tugdeck/src/spikes/spike-arc-shade.tsx` and `.css` (landed as `19981c05b` and `e3ed074c5`): the shade, the accented endcaps on the ARC cell, four cards on a free canvas with connectors drawn beneath them, per-card ports, drag with raise-on-touch, expand, and Tidy. It runs on fixtures and has not been driven by real arc facts. The user reviewed it rendered across four revisions; it was never app-tested. **(verified as code; behaviour seen by the user, not measured)**

**[F07] ⌥⌘R appears free.** The only R chord found is Maker ▸ Reload on ⇧⌘R (`tugapp/Sources/MenuBarBuilder.swift:784`). The search covered the menu bar and top-level deck sources, not every card's key handlers. **(searched, not exhaustive)**

**[F08] Tests that read the Z2 arc cell exist.** `at0473-arc-cockpit`, `at0475-arc-faces`, `at0484-arc-z2-instrument` and `at0525-arc-transport-resume-z2` matched a search for the arc cell and placard. Which of them assert cell order or open the placard was not read. **(found by search; contents unread)**

---

## Decisions {#decisions}

### The cell and the shade

**[B01] The term stays Arc.** No "Flow" enters the product or the code. The ladder is the arc's own history, not a new noun.

**[B02] JOBS moves left of ARC; ARC is the rightmost Z2 cell.** The cell that toggles the largest surface sits at the row's end.

**[B03] The ARC cell toggles a shade, and the arc placard is removed.** Pressing the cell raises or lowers the shade. While it is up, the cell's existing endcap lines (the L-shaped tick and rule beside the label) take the accent colour. A line added above the cell was tried and rejected because it upset the row's layout.

**[B04] ⌥⌘R toggles the shade too.** Subject to [F07] being confirmed against the full key map.

**[B05] The shade rises from the bottom over 80% of the transcript.** The top 20% of the transcript stays visible and inert, because the transcript must never be wholly hidden. Escape lowers the shade.

**[B06] The shade has three forms, chosen by what the session has.**
- No brief and no arc: a short shade with a hint on how to start an arc and a link to a help page that says what an arc is.
- A brief and no arc: the ladder standing at Brief, with Open Arc on the Brief card.
- An arc: the full ladder.

### The cards

**[B07] The ladder is four cards on a free canvas: Idea, Sketch, Brief, Arc.** Each can be dragged and expanded, comes to the front when pressed, and returns home on Tidy. Connectors draw beneath every card, and each card owns its ports. This is the spike's behaviour and it is what was approved; fixed positions were offered and refused.

**[B08] Card positions persist per arc.**

**[B09] The Arc card is full size and carries the popup's content.** The binding line (`^name ─── session`), the track and phase word, the step list, and the Stop / Changes / Unbind / Replay / Discard bar, as the popup shows them today. It is not pinned; it moves like the other three.

**[B10] The Brief card shows the arc's brief** and offers Open in Text Card.

**[B11] The Idea card shows the originating prompt; the Sketch card shows a digest** of the turns between the idea and the brief. Both link back to their source session.

### Where the ladder's facts come from

**[B12] The origin is captured when the arc starts, and copied, never linked.** Nothing is recorded while the idea and sketch are happening. When an arc opens, the door looks back over the conversation that led to the brief, writes a summary of the idea and a summary of the sketch, and records both in the arc's own documents beside the brief, with a reference to the source session and the turns they cover. The cards read that record. Capturing at the start means the brief skill records nothing extra, and the door is already a model turn with the conversation in hand, so the summaries cost no separate call. The record is a copy for the user's reason: a link to another session or project leaves "the possibility open that … the resources change from under us."

**[B13] Every arc has a brief.** An arc opened with no brief asks for guidance at the door and adopts that guidance as the brief, so the Brief card is never empty once an arc exists.

### Prompts while an arc is open

**[B14] No sigil and no typed aim.** The composer is unchanged. "People won't know to type it." This also avoids a second meaning for `^` ([F05]). While an arc is open, the session treats a prompt as possibly meant for the arc, and the model decides.

**[B15] Clicking a card is a hint.** It sets a chip in the composer that travels with the next prompt. The model may still read the prompt otherwise.

**[B16] A prompt about the arc is a nudge or a rethink.** A nudge adapts the steps not yet built and the arc keeps running, without asking. A rethink is proposed by the model and confirmed by the user, because it stops running work; the arc stops and the work returns to the brief, and from there either re-devises or opens a new arc.

**[B17] The shade shows what the last prompt was taken as,** so a wrong reading is visible and correctable.

### What does not change

**[B18] The Arcs card and the Changes shade's arc lane stay as they are.** The Arc card's Changes verb keeps revealing that lane.

---

## Open Questions {#open-questions}

- **What the Idea and Sketch cards show before their facts exist.** The deck work ([B02]–[B10]) can land on existing facts, but [B11] needs [B12]. The proposal is that until the capture of [B12] is built, and for arcs opened before it, the two cards say there is nothing recorded. Not confirmed by the user.
- **Capture when the door does not hold the conversation.** [B12] assumes `/arc` runs in the session that shaped the brief. Three cases break that: the arc is opened from another session or from the Arcs card; the session was compacted, so its early turns are no longer in the model's context; the brief was written by hand. In the first two the transcript is still on disk and the brief's commit carries its session's trailers, so the door could find and read it with `tugtool session show`; whether it should, and what the cards show when there is nothing to find, is not settled.
- **Whether the arc's record keeps the turns themselves** or only the two summaries and the reference. The summaries are what the cards show; the turns would make the record survive the source session being trashed.
- **What tells the shade a brief exists before any arc does.** With capture moved to the arc's start, the "brief, no arc" form of [B06] still needs some fact that this session wrote a brief.
- **How a nudge reaches the arc's worker session.** The arc often runs in a session other than the one the user is typing in. The delivery path is not designed.
- **What re-devising after a rethink does to steps already built.**

---

## Non-goals {#non-goals}

- **A "Flow" term.** Rejected by the user; see [B01].
- **A typed `^brief` / `^arc` aim.** Built in the spike and then dropped; see [B14]. Reserving arc names to make room for it was considered and is unnecessary now.
- **Message fields inside the cards.** "A non-starter": the real composer stays the only place a prompt is written.
- **A marker line above the ARC cell.** Rejected for upsetting the layout; see [B03].
- **A pinned or fixed-position Arc card, or a fixed layout for the first version.** Offered and refused; see [B07], [B09].
- **Linking to the source session's live transcript as the cards' content.** Rejected in favour of copying; see [B12].
- **Changes to the Arcs card or the Changes arc lane.** See [B18].
- **Special handling for private sessions.** Private-session support is partial today and "this isn't worth worrying about now."
- **Tear-off of a ladder card into a deck card.** The spike notes the gesture and snaps the card back; nothing was decided about making it real.
- **The spike's invented semantics.** One new step per brief change, and a note that reopens a finished arc, were stand-ins in the spike and are replaced by [B16].

---

## Exit {#exit}

**An arc.** The work falls into three parts, and the first stands alone.

*The cell and the shade (deck only, existing facts).* Confirm ⌥⌘R; swap JOBS and ARC with their focus order, narrow-width order and the tests in [F08]; build the shade in its short and full forms with its inert strip, Escape, focus handling and motion that pays its costs before the first frame; make the cell the toggle and remove the placard; graduate the spike's canvas with positions stored per arc; host `ArcPopoverContent` and its verbs in the Arc card and re-anchor Discard's confirm; build the Brief card from the document `arc-start` names; write the short shade's hint and the help page it links to.

*The captured origin (Rust and plugin).* The door summarises the idea and the sketch when the arc starts and records them in the arc's documents with the brief; a session fact that a brief was written here, for the ladder standing at Brief; the door adopting guidance as a brief; the Idea and Sketch cards reading the copy.

*Prompts while an arc is open (plugin and deck).* The session's instructions for reading a prompt as ordinary, a nudge or a rethink; the click-to-hint chip; the nudge verb and its delivery; the rethink proposal and confirm; the shade's "taken as" line.

The second and third parts can follow the first in either order. A design decision and an update to `tuglaws/work-grammar.md` belong with whichever part first changes what an arc records.
