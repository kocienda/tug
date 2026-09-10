# Session Minimize — the minimized Session card and the wall it makes

**Purpose:** A Session card has no minimized form, so a split slot can show only as many sessions as fit at full height. The user wants a minimize control that leaves a session as instruments alone — masthead, Z2, and a way back — so one split slot can hold a wall of sessions being watched rather than talked to.

---

## Purpose {#purpose}

The request, in the user's words: "add a minimize control to the session card. When minimized, a session should show *just*: the masthead (with a complete/un-truncated detail line for the pulse), the Z2 status area, and a big/obvious button to un-minimize … My goal is to make it so that a single imposer slot could easily show 8 or 10 sessions when split and the deck/canvas is a reasonable height."

The spirit, as the conversation settled it: a minimized session is one you are keeping an eye on, not one you are talking to. The transcript and the composer are the conversation; the masthead and Z2 are the instruments. The minimized card is the instruments without the conversation — nothing on it scrolls, streams, or takes a keystroke.

Three things came out of looking at the drawing that the opening request did not name: the way in belongs at the leading edge of the prompt entry's toolbar row, not beside the submit; the two masthead lines have to say more when the card is minimized, or the wall does not work; and the transition between the two forms must be an excellent animation, not a cut.

The design surface is the **Session Minimize** spike card (`tugdeck/src/spikes/spike-session-minimize.tsx`), opened from Maker ▸ New Spikes Card. It is cited below as *the spike*.

---

## Evidence {#evidence}

**[F01] The masthead already truncates rather than wraps, by design** — `SessionMasthead` is a fixed 72px tier so the card beneath never moves on a pulse; every line ellipsizes (`components/tugways/session-masthead.tsx`, `--tug-masthead-height` in every theme file). Minimized there is no card beneath, which is what frees the beat to take a second line. **(verified)**

**[F02] Z2's five cells are budgeted to exactly the slim width** — `tug-status-cell.css` sizes STATE · TIME · CONTEXT · TASKS · JOBS in `ch` at the row's 10px type with a `--tug-space-2xl` gap, totalling ~649px, and collapses TIME, then TASKS, then JOBS through `@container session-status` rungs at 645 / 520 / 405px. A minimized card at any width narrower than slim loses cells in that order, with no new work. **(verified, read from the stylesheet)**

**[F03] The minimized shape as drawn measures 159px at the slim width** — masthead tier (72 + 16 for the second beat line), the Z2 row, and the Show Transcript bar, measured with a `ResizeObserver` off the first card of the spike's wall and read out on the card. At a 900px canvas, with the imposition's 5px gap, that fits **5**. Eight needs a card under about 108px. **(verified, measured in the running app)**

**[F04] A split column already exists** — `ColumnMode = "stack" | "split"` per slot in `lib/layout-imposer.ts`, with members dividing the run at `IMPOSITION_GAP_PX` seams and a per-slot order and shares that survive re-splitting. The wall is that mechanism with minimized members; it is not a new layout. **(verified)**

**[F05] The prompt entry's toolbar is three positions in one flex row** — Z4A leading-fixed, Z4B centred-floating between two equal spacers, Z5 trailing-fixed, per [D97]; occupants are assignable, positions are contract. A control placed *ahead* of Z4A is a fourth leading-fixed occupant, and the two Z4B spacers still centre the chips between the route group's right edge and Z5. **(verified)**

**[F06] The D97 diagram is stale on two counts** — its placeholder reads "Ask Claude to build, fix, or explain" where the card now says "Ask Tug to build, fix, or explain" (`SESSION_PROMPT_PLACEHOLDER`, `session-card.tsx`), and it shows a `Project: /path` badge in Z4B that the prompt route no longer mounts; Z4B on that route is the Claude Code identity badge and one AI settings chip. **(verified, read from the code)**

**[F07] Minimized state has no home yet** — nothing in `DeckState`'s card entry, `card-registry`'s size policy, or the pane carries a per-card collapsed flag; the nearest precedents are the retired maximize toggle (still named in `action-vocabulary.ts` and `command-registry.ts`) and the per-card width preset. **(verified by grep; not a measurement of what the flag should be)**

---

## Decisions {#decisions}

**[B01] Minimized, a Session card is exactly: the masthead, Z2, and a full-width "Show Transcript" bar.** The transcript pane and the prompt entry are gone from view. Everything live survives — the phase dot, the tape, the description, the beat, the five instruments and their placards — and nothing else does. This is the spike's wall, and it is the shape the user chose after seeing three candidates for the way back.

**[B02] The beat gets two lines, on a fixed tier one line taller than the masthead's 72px.** One line at full width still clips a long beat; two lines make it complete for nearly every beat the app writes. The tier is fixed in both directions: a short beat leaves its second line empty, so a column of minimized cards never ripples as beats change length. The tape rides the two-line box.

**[B03] The way back is one full-width bar under Z2 reading "Show Transcript".** Chosen over a button in the vacated Z5 seat and over a toggle in the pane's control cluster: it is the largest target the card can offer, it reads at a glance in a wall, and the word says what comes back. "Show Conversation" was considered and rejected — the pane holds a transcript, and the app's vocabulary already says so.

**[B04] The way in is a Minimize button at the leading edge of the prompt entry's toolbar row, ahead of Z4A, separated from the route group by a gap wider than the row's own rhythm.** Card chrome on the left, the message's own controls on the right; Z5 keeps the submit alone. The gap is what makes the two read as different kinds. The section menu and a chord are the other doors, so the button is the discoverable one, not the only one.

**[B05] Minimized is a fact about the card, stored with the layout, set by one action.** The button, the section menu item, and the chord all dispatch it ([L11]); the state lives on the card's deck-state entry alongside its width preset and persists with the layout. The composer folds rather than unmounts, so a half-typed prompt survives a minimize; the transcript store keeps streaming and the beat is where the reader sees it.

**[B06] The transition between the two forms must be an excellent animation.** A cut would make a wall of ten flicker every time one opens. The folding of the transcript and composer into the tier, and their unfolding back out, is a first-class piece of this work, judged to the same standard as the reveal-on-arrival hold: a motion with a shape, a fixed beat, and nothing that reflows the neighbours until it is done. What "excellent" is concretely is an open question below, and a design spike is the right place to settle it.

**[B07] Opening one card in a wall gives it a reading share of the column — never the whole column.** Six tenths in the spike's drawing. The siblings keep their minimized height; what no longer fits scrolls, and the column scrolls to put the opened card just under its neighbour above so the reader keeps their place. One open per split: opening another minimizes the first, so the wall stays a wall. A card that wants more than its share is the ordinary Session card, and gets that by leaving the split.

**[B08] The beat carries more weight when minimized.** A minimized session's two lines are written for a reader who will not open the card: what it is doing, what it is waiting on, what it last finished. This is a change to what the pulse *says*, not how it is drawn, and it is the thing that makes a wall work. It cannot be shown in the spike, and it is in scope for the arc.

**[B09] A minimized card's size policy drops its minimum height to the tier.** The Session card's registered minimum is sized for a transcript and a composer; a split slot cannot pack minimized members unless the minimum follows the form. The width policy is unchanged.

---

## Open Questions {#open-questions}

- **What the animation is.** [B06] says it must be excellent and says what excellent excludes; it does not say the shape. Candidates worth drawing: the transcript pane and composer folding upward into the tier while the bar slides in from below; a cross-fade with the tier held in place; the masthead staying pinned while everything below collapses on a fixed beat. Settled by a design spike, not by prose.

- **Whether the count goal survives the shape.** [F03] puts the chosen shape at 5 per 900px canvas against a stated goal of 8 to 10. The floor is the masthead tier plus Z2's two-line instrument. The ways to close the gap each change what "just the masthead and Z2" means — a one-line Z2 with the label inline, a two-line masthead when minimized, or accepting fewer per slot and scrolling the column. This is the user's call.

- **Whether a split slot of minimized cards packs to content or keeps equal shares.** The imposer's split mode divides the run into shares; a wall wants members at their natural height. Read `allocatePlaceHeights` and decide whether minimized members are a third standing or a share of zero.

- **Focus in the minimized form.** The card has three focusable things: the Z2 cells, the pane cluster, and the bar. Return on a focused minimized card should be Show Transcript. Whether the bar carries the default ring is a focus-language question ([L-focus] doctrine in `tuglaws/focus-language.md`).

---

## Non-goals {#non-goals}

- **A minimize button in the Z5 seat beside the submit.** Drawn as candidate A in the spike and rejected: it put card chrome in the message's corner, and the way back it implied (Expand in the same seat) said less than a bar.
- **A toggle in the pane's control cluster as the way back.** Candidate C. Densest wall, but an expand affordance the size of a close button next to the close button is the least obvious way back, and obviousness was the requirement.
- **"Show Conversation".** The bar says "Show Transcript".
- **A one-line beat.** Rejected in favour of [B02]; it clips.
- **A marquee for a long beat.** Not drawn, not wanted: ten scrolling lines in a wall is motion noise.
- **A minimized card that scrolls, streams, or takes a keystroke.** The form is instruments only.
- **An opened card taking the whole column.** Rejected by [B07].
- **Correcting the [D97] diagram in this brief.** [F06] records what is stale; the diagram is a doctrine edit to make once, with the new leading seat in it, when the control lands.

---

## Exit {#exit}

**An arc**, on this brief, with a design spike inside it for the animation ([B06]).

The first steps, in the order they must land: the minimized flag on the card's deck-state entry and the one action that sets it, with the button ahead of Z4A ([B04], [B05]); the minimized form itself — the taller tier, the two-line beat, Z2, the bar — and the size policy that lets it pack ([B01], [B02], [B03], [B09]); the split column's treatment of minimized members and the reading share on open ([B07], and the packing question above); then the animation, drawn in a spike before it is built ([B06]); and the beat's minimized register ([B08]), which can proceed in parallel once the form exists. The [D97] diagram is corrected when the toolbar seat is real.

The spike stays open until the animation spike closes into it or replaces it; then both graduate — the durable findings into `tuglaws/`, the files deleted.
