# Share Turns: Pick Turns in a Session Card and Send a Rendering

**Purpose:** There is no way to hand part of a session transcript to another person as something they can read in an email or a text message. The user wants to mark the turns they mean and save out a rendering of the card's transcript.

---

## Purpose {#purpose}

The user's words:

> Let's say I wanted to *share a session transcript or a portion of one* with another person, i.e. send it in email or a text. How might I do this? You know, it would be great if I could somehow indicate the turns I wanted and save out a rendering of the card transcript.

Three things are missing today. Nothing selects a range of turns. Nothing produces a rendering, as opposed to a markdown source file the recipient has no viewer for. Nothing hands the result to Mail, Messages or the clipboard in a form those accept.

---

## Evidence {#evidence}

**[F01] `/export` saves the whole transcript and only as source text** — the `export` command in `tugdeck/src/components/tugways/cards/session-card.tsx` reads `codeSessionStore.getSnapshot().transcript`, builds both renderings with `transcriptToMarkdown` and `transcriptToJsonl` from `tugdeck/src/lib/transcript-export.ts`, and posts them through `exportSession` in `tugdeck/src/lib/os-export.ts`. The host case `.exportSession` in `tugapp/Sources/MainWindow.swift` runs `presentExportPanel`, an `NSSavePanel` whose File Format popup chooses Markdown or JSON Lines. There is no turn argument anywhere on that path. **(verified)**

**[F02] The markdown serializer already takes a slice** — `transcriptToMarkdown(transcript: ReadonlyArray<TurnEntry>)` and `transcriptToJsonl` iterate whatever array they are given, and each turn goes through `turnEntryToMarkdown` (`tugdeck/src/lib/turn-entry-markdown.ts`), the same serialization the per-row Copy uses. A selection of turns needs no change to either function. **(verified)**

**[F03] The transcript is a windowed list** — `tugdeck/src/components/tugways/cards/session-card-transcript.tsx` mounts a `TugListView` against a `SessionTranscriptDataSource`, and its cells carry comments about surviving "windowed remounts". Turns outside the window are not in the DOM, so a snapshot of the live card cannot be the rendering of an arbitrary selection. **(verified)**

**[F04] The host already has a snapshot path and a save panel, and no PDF or share path** — `takeSnapshot` is called in `tugapp/Sources/MainWindow.swift` and `tugapp/Sources/BodyViewController.swift`, and `NSSavePanel` in `MainWindow.swift` and `BridgeHandler.swift`. A search of `tugapp/Sources` for `createPDF`, `WKPDFConfiguration` and `NSSharingService` matched only the snapshot and save-panel files, with no PDF or sharing-service call among them. **(verified by grep; the snapshot call sites were not read in full)**

**[F05] The secret scrubber is not reachable from the deck** — `scrub_text` lives in `tugrust/crates/tugcast/src/feeds/secret_filter.rs` and its only other caller is `tugrust/crates/tugcast/src/semantic/ingest.rs`. No deck-side route calls it. **(verified by grep)**

**[F06] The deck knows which sessions are private** — `tugdeck/src/lib/session-private-store.ts` exists. Its interface was not read. **(existence verified; shape not)**

**[F07] Transcript rows have a Copy affordance and no row menu was found** — `turnEntryToMarkdown` is imported by `session-card-transcript.tsx` and `session-card-z1b.tsx` for the per-row Copy. A grep of `session-card-transcript.tsx` for context-menu and row-action names matched nothing, so where a per-turn "Share from here…" door would hang is not established. **(the absence is a grep miss, not a reading of the file)**

**[F08] Mounting many transcript entries at once has stalled the deck before** — the View › Zoom freeze was traced to roughly 260 transient entry mounts each paying a forced style read. This is recalled from an earlier investigation, not re-measured for this brief; it is the reason the rendering's cost on a large selection is a named risk. **(recalled, not re-measured)**

---

## Decisions {#decisions}

**[B01] The rendering wears the user's current theme, and there is no other look.** The user ruled this directly: "I don't want to do a design exercise to figure out a new way for session transcripts to look. They should export *with the current theme*." There is no "paper" rendering, no theme chooser in the share bar, and no export-only stylesheet. What the recipient sees is what the card shows.

**[B02] PNG is an output, with no height cap, and the PDF is one continuous page.** The image is the one output that reads inline in a text thread, and it is as tall as the selection is. The host photographs the document in tiles and stitches them into one PNG, at the display's scale while the bitmap stays inside a pixel budget and at 1× past it, so a very tall share is drawn less sharply rather than refused. The PDF has no page breaks: it is a single page of the column's width and the document's height, so no row, code fence or line is ever cut across a boundary.

*Revised 2026-11-13, by the user:* the first build capped the image at 8000 pixels, refusing a taller one and switching the format to PDF, and printed the PDF onto letter-proportioned pages. The user rejected both on sight: a line cut in half at a page break, and "why can't we make an image as tall as we want?" The cap and the pagination are gone.

**[B03] The unit of selection is the turn.** A turn is the user's prompt and the whole reply to it, the same `TurnEntry` the transcript renders and `/export` serializes ([F02]). Selecting part of a reply is what text selection and Copy are already for.

**[B04] Selection happens in the transcript itself, in a share mode on the Session card.** Each turn shows a check box at the right of its header row, just after the turn address; the participant icon keeps its seat, since who spoke is never traded for a control. A click toggles one, a shift-click extends a range, and non-contiguous picks are allowed. The shade wears the modal header convention every sheet and alert wears (`styles/tugx-header.css`, the two-line case): the Share icon, the title Share Turns, and the instruction as its description, so the title is the largest type on the shade and the instruction is never a style of its own. Mark All and Clear All sit in their own row directly under the description, with the count of marked turns beside them. Below are three rows — Turns (how tool calls appear in them), Format, and Action, a popup menu of Preview…, Copy, Save… and Share… — whose labels sit in the header icon's column, so the controls share the left edge of the title, the description and the Mark All row. At the bottom are two buttons only: Cancel, and one button that wears the chosen action's name and performs it. Share mode is a shade, like the card's Changes and History shades: it rises from the bottom of the transcript and rests on the Z2 status bar, while the composer and Z2 stay where they are. Unlike those shades it is modeless, with no scrim and nothing inert, because the turns are marked in the transcript above it; the transcript takes the shade's height as its bottom inset so the newest turns can still be marked. Escape leaves the mode. The doors are `/share`, a File menu item, a Share Turns button in the card's masthead second from the left (after Rename), and a per-turn Share from Here… in the transcript cell menu ([F07]).

*Revised 2026-11-13, by the user, after the first build:* the first build replaced the composer with a bar in the find bar's seat and kept Copy, Save… and Share… disabled until a preview had been shown and dismissed. The user found the bar "disastrously bad" and Save "does nothing" — a disabled button that never said why. The shade above and the action rule in [B09] replace both.

**[B05] The rendering is made by the real transcript components in a hidden body web view, never by a snapshot of the live card and never by a second renderer.** The live card is windowed ([F03]), so it cannot supply unmounted turns. A separate static HTML renderer would drift from the card and would itself be the design exercise [B01] rules out. The hidden view mounts only the selected turns, unwindowed, at a fixed column width, and the host takes the PDF or the image from it.

**[B06] One selection yields three outputs.** PDF for an email attachment; PNG for a text message under [B02]; Markdown and plain text for pasting into a message body, through `transcriptToMarkdown` over the slice ([F02]).

**[B07] Three destinations.** Copy writes rich HTML and plain text to the pasteboard so a paste into Mail is styled. Save… extends the existing export panel's format popup ([F01]). Share… opens the macOS share picker with the file. All three are the host's work, alongside `presentExportPanel`.

**[B08] Tool calls default to one-line summaries, with Full and None as the other choices; thinking is never included.** A shared excerpt is read by somebody who was not there, and full tool output buries the conversation. Thinking is left out for the same reason `tugtool session show` leaves it out.

**[B09] Nothing leaves the machine without a preview, and the text is scrubbed first.** Sharing is outward-facing and not reversible. The selected text passes through `scrub_text` and home-directory paths are shortened to `~` before the rendering is made, which needs a route from the deck to the scrubber that does not exist today ([F05]). A session marked private asks for confirmation before its turns are rendered ([F06]).

Every action acts. Copy, Save… and Share… are enabled whenever a turn is marked. When the held preview is of exactly the current selection, tool mode and format, a press acts at once; otherwise the press makes the artifact and shows it in the preview sheet with Cancel and a button named for the action (Copy, Save…, Share…), and acts only on that button. Preview… shows it with Done alone. So nothing leaves unseen, and no button is a dead control waiting on a step the user was never told about.

**[B10] The header names the session title, the project's name, the date and the turn numbers.** The project's name and not its path, for the same reason as the `~` shortening.

**[B11] `/export` stays, and becomes the same path with every turn selected.** It is the whole-session archive in Markdown and JSON Lines; share mode is the selection and the rendering. They share the slice serialization ([F02]) and the save panel ([F01]) so there is one export path with two entrances.

---

## Open Questions {#open-questions}

- **How does the hidden view behave on a large selection?** Unwindowed mounting is the shape that stalled the deck before ([F08]). The hidden view is a separate web process, so the deck should stay live, but the selection size at which rendering needs a progress state, or a refusal, is unmeasured. A reading of render time against turn count on an aged session settles it.
- **Where is the PNG height cap?** *Closed 2026-11-13:* there is none ([B02]).
- **Does the hidden view paint?** Body views are hidden by opacity and never `isHidden` so that they keep painting, per the comments in `tugapp/Sources/BodyViewController.swift`. Whether a body that is never shown at all paints its full height for `createPDF` and `takeSnapshot` is untested, and a covered harness window is known to suspend `requestAnimationFrame`.
- **Where does the per-turn door sit?** [F07] found no row menu. It is either a new affordance on the row or a door that exists only at the card level.
- **Does the current theme's dark ground print acceptably as a PDF?** *Closed 2026-11-13:* the PDF is not paged at all ([B02]); its one page carries the theme's ground edge to edge, read from a rendered file.

---

## Non-goals {#non-goals}

- **A light "paper" look, or any export-specific styling.** Proposed and rejected by the user ([B01]). Not offered as an option either.
- **A hosted link.** Tug has no server, and adding one to share a transcript is a product of its own.
- **A snapshot of the live card.** Rejected in [B05]: the windowed list does not hold the turns.
- **A second, static renderer for export.** Rejected in [B05]: it drifts from the card and reopens [B01].
- **Selecting part of a turn.** Rejected in [B03].
- **Thinking blocks in a shared rendering.** Rejected in [B08].
- **A `tugtool session show --turns` range.** It came up as a small adjacent change and is not part of this work.

---

## Exit {#exit}

**An arc.** The work falls in three pieces, and they land in this order because each is useful without the next:

1. Share mode on the Session card ([B03], [B04]) with Markdown and plain-text Copy and Save of the selected slice ([B06], [B07], [B11]). This is web-side work over what `/export` already has, plus the scrub route ([B09]) and the preview.
2. The hidden body view and the rendered outputs: PDF and capped PNG in the current theme ([B01], [B02], [B05]). The first three open questions are answered here, by measurement, before the outputs are wired to the bar.
3. The share picker and the rich pasteboard ([B07]).
