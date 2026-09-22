# The Session card is the drop surface

**Purpose:** A file or image dragged onto a Session card is only accepted over the prompt entry; a drop over the transcript or anywhere else in the card does nothing. The card's content area should accept the drop and land the files at the composer's caret.

---

## Purpose {#purpose}

In the user's words:

> When I drag a file or image onto a session card, and I hover over the prompt-entry, the drop will work. Obviously. However, if I hover over the transcript or any other part of the card, it won't. Feels like the drop should still work in this case, and should insert the files wherever the caret is.

The complaint is about where the surface ends. Dropping a file on a Session card is one gesture with one meaning — *put this in the prompt* — and the card currently honours it only over the bottom fifth of itself. Nothing about the transcript makes it a place where that gesture should stop meaning something.

---

## Evidence {#evidence}

**[F01] The drop surface is the prompt entry, and it is already deliberately continuous.** `useComposerDrop` (`tugdeck/src/components/tugways/use-composer-drop.ts`) returns four handlers that `tug-prompt-entry.tsx:4027` spreads on `TugEntryShell`'s root, so the editor, attachment strip, toolbar, status row and the gaps between them are one surface. Its module docstring states the intent outright: *"A composer is one continuous drop surface."* The work below extends a boundary that was already drawn once on purpose; it does not invent the idea. **(verified — read out of the code)**

**[F02] Two layers already compose by `defaultPrevented`, and a third would use the same protocol.** `drop-extension.ts` attaches host-level listeners that claim drags over the editor itself; `useComposerDrop`'s handlers open with `if (event.defaultPrevented) return;` and catch what the substrate declined. React synthetic events bubble from the target outward, so a card-level handler mounted above the entry runs last and sees the flag set by either inner layer. No new coordination mechanism is needed. **(verified)**

**[F03] Nothing above the prompt entry listens for a drag — not in the deck, not in the host.** `session-card.tsx` carries no `onDragOver`/`onDrop`. A search of `tugapp/Sources` for `registerForDraggedTypes` / `performDragOperation` returns nothing, so the Swift host installs no drag destination and WKWebView hands file drops straight to the page. **(verified)**

**[F04] An unclaimed file drop on the page may not be inert.** WebKit's default action for a file dropped on a region no script has claimed is to navigate to that file, which in a single-webview app means the deck is replaced. Combined with [F03] this suggests today's behaviour over the transcript is not "nothing happens" but "possibly something bad happens." **(inference, not verified — a drag of a `.png` from Finder onto a Session card's transcript in a running Tug.app would settle it in one try, and the answer changes the severity of this brief, not its shape.)**

**[F05] `PromptInsertTarget` is already the composer-agnostic way to send an entity into a prompt, and files are the one payload that bypasses it.** The interface (`tugdeck/src/lib/prompt-insert-target.ts`) carries `insertAtom`, `insertText`, `raise`, and the optional `insertCommand`/`runCommand`; its docstring names the design rule — *"nothing about sending a file reference into a composer is a fact about a session."* The Session card already holds one of these. But a dropped file goes through `processAttachmentFiles`, which needs the live `EditorView` and the `attachmentBytesStore`, both private to `tug-prompt-entry.tsx`. **(verified)**

**[F06] The interface already distinguishes "at the caret" from "appended," and the two mean different things here.** `insertAtom` is documented as *"Drop one atom at the caret. Additive: an in-progress draft survives it."* `insertText(…, at)` inserts at the offset a drop point resolves to, *"or appended when `at` is `null`."* The requested behaviour for a drop outside the composer is the former, not the latter. **(verified)**

**[F07] `SessionCardContent` renders the card's content area only; the title bar is the card frame's chrome.** The component's root is `<div className="session-card" data-slot="session-card">` (`session-card.tsx:4479`), registered as card *content* by `session-card-registration.tsx`. So the content-area boundary this brief wants is an element that already exists and needs no new wrapper. **(verified)**

**[F08] The card already knows when it cannot accept.** The same root renders a picker backdrop when there is no binding, a restoring backdrop during a transport restore, and the prompt entry carries `inert` while a restore replays (`tug-prompt-entry.tsx`, *"Whole-entry stand-down"*). Each of these is a state in which there is no composer to insert into. **(verified)**

---

## Decisions {#decisions}

**[B01] The drop surface is the Session card's content area — the title bar is excluded.** `.session-card` is exactly that region ([F07]), so the surface is one element's worth of handlers. The title bar stays out because it is the card's drag handle: a file hovering there is ambiguous between "put this in the prompt" and a gesture about the card itself, and an ambiguous target is worse than a smaller one. Revisit only if users are observed aiming at the title bar.

**[B02] A drop inside the composer keeps resolving to the drop point; a drop outside it lands at the caret.** Over the editor there is a document under the pointer and `dropOffsetAtCoords` already answers precisely; over the transcript there is not, and the honest answer is the composer's live selection ([F06]). This is the user's stated expectation and it makes the card-level drop identical to `Session ▸ Insert File…` — the same insertion, reached by a different door. It is explicitly *not* `insertText(…, at: null)`, which appends: appending is right for a dragged jot and wrong for a file the user aimed at a caret.

**[B03] Files reach the composer through `PromptInsertTarget`, via a new optional operation.** Adding `insertFiles(files)` alongside `insertCommand`/`runCommand` — optional on the same seam, for the same reason — lets `session-card.tsx` route a drop using the target it already holds, with no reference to the entry's `EditorView` or bytes store ([F05]). The Session adapter implements it over the store's pending-insert slots, which `TugPromptEntry` already observes and consumes, so the existing `processAttachmentFiles` pipeline stays where it is and gains one more caller. This rules out the cheaper alternative in Non-goals.

**[B04] An inactive card accepts, and raises itself on the drop.** Dropping on a background Session card means "put this in *that* card's prompt," which is the reading the gesture's aim already supports; `PromptInsertTarget.raise()` exists precisely so the prompt an entity lands in is the one the user ends up looking at. The risk is an accidental drop on a card the user did not mean — accepted, because raising makes the mistake visible immediately and the insert is one undo away.

**[B05] The cue points at the destination, not at the pointer.** Keep the editor's drop ring (`markEditorDropActive`) and the drop caret, but for a card-level drag paint the caret at the *insertion point* rather than tracking the cursor. Dragging over the transcript should visibly say *this is going into the composer, here*. A ring around the whole card would say "accepted" without saying "lands here," which is the less useful half of the message.

**[B06] The card declines when there is no composer to accept into.** No binding (picker up), an `inert` entry mid-restore, a landing shade over the card ([F08]) — the handler does not call `preventDefault`, so the drag reads as refused rather than silently swallowed. Block-reorder drags are excluded already by the existing payload test: they carry neither `Files` nor a jot payload.

---

## Open Questions {#open-questions}

- **Is [F04] real?** Whether an unclaimed file drop on the transcript navigates the webview decides whether this is an affordance gap or a live hazard. One manual drag settles it, and the answer does not change the shape of the work — only how it is described and how urgently it lands.
- **Does a card-level drop focus the composer as well as raise it?** [B04] settles raising. Whether the caret should also take focus (so the next keystroke continues the prompt) is a feel question best answered by trying both in a built app.
- **Do the other card kinds want the same rule?** Text cards have their own `file-drop.ts` and a different meaning for a dropped file. This brief claims only the Session card; whether the pattern generalizes is a separate look.

---

## Non-goals {#non-goals}

- **Publishing the entry's drop handlers upward through `TugPromptEntryDelegate`.** The cheaper change — the card spreads the entry's own handlers on its root — is fewer lines, but it pushes the entry's private plumbing (its `EditorView`, its bytes store) out through a ref, and it gives the Overview composer nothing. Rejected in favour of [B03].
- **A card-level drop ring or any new drop chrome.** [B05] reuses the two cues that already exist. New visual vocabulary is not needed to answer this complaint.
- **Extending the surface to the deck background or the space between cards.** A drop there has no card to name and therefore no prompt to aim at.
- **Changing what a dropped file *becomes*.** Images become attachment atoms, other files become their basename; `processAttachmentFiles` keeps deciding that. This work is about where the gesture is accepted, not what it produces.
- **Changing jot-drag behaviour.** A jot dropped outside the composer keeps the append rule it has today ([B02] names files only). Making jots land at the caret too may be right, but it is a change to working behaviour and does not belong in a fix for a gap.

---

## Exit {#exit}

An arc. The shape of the first steps:

1. Settle [F04] with one manual drag onto a Session card's transcript, and record the answer — it is the difference between a gap and a hazard.
2. Add `insertFiles` to `PromptInsertTarget` and implement it in the Session adapter over the store's pending-insert slots, with `TugPromptEntry` consuming the slot through its existing `processAttachmentFiles` path. This lands first and alone: it is testable without any drag, by driving the slot directly.
3. Mount the card-level drop handlers on `.session-card` ([B01]) — accepting `Files` and jots, deferring on `defaultPrevented` ([F02]), declining on the states in [B06], raising on drop ([B04]).
4. Point the cue at the insertion point for the card-level path ([B05]).

Steps 3 and 4 depend on 2; 1 depends on nothing and should not block the others. App-test coverage belongs with step 3, where the surface first exists to aim at — the harness's `nativeDrag` is the tool, and any new test carries its `@covers` line.
