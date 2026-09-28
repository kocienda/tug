<!-- brief-skeleton v1 -->

# Dictation: ⌘D toggles it, leaving the composer ends it, and an ordinary end keeps the words

**Purpose:** The mic that landed in `dictation-mic` is reachable only by pointer, stays live when the user moves on to something else, and throws away whatever the recogniser had not yet finalized on every kind of end — so pressing stop after a sentence can lose the sentence. A keyboard door, a focus-loss release, and a distinction between *finishing* and *cancelling* are what is wanted.

---

## Purpose {#purpose}

After joining and relaunching the dictation arc, the user's two notes: "Add ⌘D as a toggle for dictation when an active input field has focus, starting and stopping dictation with each successive usage," and "When a switch away from an input area with active dictation running, end dictation and transcribe."

The second note carries a decision the first arc made the other way. Its brief ([B08] of `briefs/dictation-mic-brief.md`) had every end keep finalized text and *discard* the volatile tail, and the plan's Spec S03 rule 5 made the host enforce it. Asked whether ⌘D and the button should finish rather than truncate, the user settled it: "⌘D means *I'm done talking*, not *immediately truncate dictation*. So should tapping the button in Z5. Only `escape` should truncate transcription."

---

## Evidence {#evidence}

**[F01] ⌘D is free on every layer it would have to cross.** `tugdeck/src/components/tugways/keybinding-map.ts` binds no `KeyD` with `meta`; no Swift menu item in `tugapp/Sources/` carries `keyEquivalent "d"`; and `@codemirror/search`'s default `Mod-d` (select next occurrence) is installed only in `tug-code-view.tsx`, never in a composer's extension set. It is not on the ⌃⌥⌘ set Keyboard Maestro owns, and it is a one-hand chord. **(verified by grep)**

**[F02] Both composers already own a responder that a chord can reach.** `TugPromptEntry` registers its actions through `useResponder`, and the Overview composer has one with `id: "overview-composer"`; both spread `CANCEL_DIALOG` in conditionally while they own dictation. `keybinding-map.ts`'s default routing is `first-responder`, which walks up from whatever holds the keyboard — so a binding on the map reaches the focused composer and only it. The mic's `onClick` is one call, `dictationStore.toggle(composerId, cardId, target.dictation)`, and nothing about it is pointer-specific. **(verified)**

**[F03] Nothing today ends dictation when focus leaves the composer.** `dictation-store.ts` subscribes to `getAppLifecycle().observeApplicationDidResignActive` and `cardModalHoldStore` for the length of a claim; the composers call `endIfOwnedBy` on submit, clear, unmount and Escape. A click on another card's body, a Tab into the cycle, or a click into the other composer's field leaves the first mic live. **(verified by reading the store and both composers)**

**[F04] Every end drops the tail, and the host makes the drop irreversible.** `dictation-span.ts`'s `end` transaction deletes `[committedTo, to)`. On the host, `DictationEngine.stop` calls `recognizer.finish()`, clears `liveId` synchronously, and emits `ended`; `SpeechAnalyzerRecognizer.finish()` does call `analyzer.finalizeAndFinishThroughEndOfInput()` but immediately cancels the task that reads `transcriber.results`, and `consume` guards on `liveId == id` anyway — so the finals the recogniser produces on finalization are never read and would be dropped if they were. The flush exists in the API and Tug discards it. **(verified from `DictationEngine.swift` and `SpeechAnalyzerRecognizer.swift`)**

**[F05] The mic itself is inside the input area.** The button sits in `TugEntryShell`'s Z5 trailing slot, so a pointer press on it moves DOM focus off the CodeMirror `contentDOM` and onto the button. A focus-loss rule keyed on the editor element would end dictation on the very tap meant to control it; keyed on the shell root, the tap stays inside. **(verified from the shell's structure and the button's mount)**

**[F06] The macOS 15 path has the same flush.** `SFSpeechAudioBufferRecognitionRequest.endAudio()` ends input and the task delivers a result with `isFinal` set; `LegacySpeechRecognizer.finish()` calls `endAudio()` and then cancels the task in the same breath, which is the same discard as [F04]. **(from the API's documented contract; the path cannot be run on this machine, as the first brief recorded)**

**[F07] Some ends cannot wait for the host.** `performSubmit` in the entry and `submit` in the Overview read the draft synchronously after ending dictation; an unmount cleanup, a modal hold landing, and the app resigning active are all synchronous too. A finish that round-trips to the recogniser cannot complete inside any of them. **(verified from the call sites)**

---

## Decisions {#decisions}

**[B01] ⌘D is the mic on a key, and nothing more.** One action, `TOGGLE_DICTATION`, bound `KeyD`+`meta` in `keybinding-map.ts` with first-responder routing and `preventDefaultOnMatch` (WebKit's own ⌘D must never fire). Each composer's existing responder spreads in a handler that makes the mic's call, `dictationStore.toggle(composerId, cardId, target.dictation)`, present under exactly the three conditions that mount the mic — a card id, a `dictation` handle, and the host handler. So the semantics are already settled by [B07] of the first brief and are not restated: idle starts, owner stops, another composer holding it moves the mic. No composer focused, or landing mode with no mic mounted, means nothing handles the chord and nothing happens. The mic's tooltip shows the chord through `commandShortcut(TUG_ACTIONS.TOGGLE_DICTATION)`, the way Submit's does. The KBF ring parked on the composer's editor stop counts as focus — the ring rests on the editor element, which is the first responder.

**[B02] Focus leaving the composer ends dictation, and the composer is the one that notices.** While `dictationOwned`, each composer registers a `focusout` listener on its **entry shell root** — not the `contentDOM` ([F05]) — and calls `dictationStore.endIfOwnedBy(composerId, "blurred")` when `relatedTarget` is `null` or outside that root. Null is a click on the canvas or a card body; outside-the-root is a Tab to another stop or a click into the other composer. A portal spawned from the composer (a chip's popover) reads as outside and ends dictation too; that is accepted rather than special-cased, because a user who opened a popover has stopped talking to the field. The store stays the owner of the releases it can see ([B08] of the first brief) and this one it cannot, so it lives with the composer on the Table T03 pattern.

**[B03] An ordinary end *finishes*: the words spoken are kept, in the recogniser's settled reading.** ⌘D, the Z5 tap, and focus-out all ask the host to finish rather than stop. The host grows a second verb, `finish`, distinct from `stop`: the engine tells the recogniser to finalize, keeps `liveId` and keeps forwarding the `final` events that arrive, and only then emits `ended`. The deck holds the span open in a new `finishing` phase — the wave still showing, a press during it ignored — until `ended`, then closes it keeping settled text. This is the recogniser's answer rather than its guess: `finalizeAndFinishThroughEndOfInput()` ([F04]) and `endAudio()` ([F06]) exist for exactly this, and Tug was throwing the result away. The user's words: "⌘D means *I'm done talking*, not *immediately truncate dictation*."

**[B04] Finish has a deadline, and the deadline promotes.** A recogniser that never finalizes must not leave a composer in `finishing` forever. The host emits `ended` after a bounded wait — on the order of two seconds from the finish request — whether or not a final arrived, and the deck, on an `ended` that arrives with a tail still volatile, **promotes** that tail to plain text rather than dropping it. The user asked for transcription; a deadline that dropped the tail would turn a slow recogniser into a lost sentence.

**[B05] Escape is the one cancel, and it truncates.** Escape keeps the first brief's semantics exactly: the volatile tail is dropped, settled text stays, the host is sent `stop`. It is the only user gesture that discards, which is what gives the user a way to take back a misheard phrase — and it is the reason [B03] of the first brief, which made tap and Escape the same end, is revised here.

**[B06] The synchronous ends promote on the deck.** Submit, clear, unmount, a modal hold landing, and the app resigning active cannot wait for the host ([F07]). Each ends as it does today but with the tail **promoted** to plain text in the same transaction that closes the span, and the host is sent `stop`. A submit therefore carries what the recogniser had heard so far, which is what a user who pressed Return while finishing a sentence meant.

**[B07] The involuntary ends drop, as now.** Supersede (another composer took the mic), `refused`, `device-lost`, and `ended { error }` keep the first brief's drop. None of them is the user saying they are done, and promoting a tail the machine cut off mid-word is not a transcription of anything.

**[B08] This revises the first brief's [B03] and [B08], and says so there.** The dictation-mic brief's "tap again or Escape closes" and "keeping finalized text and discarding the volatile tail" are superseded by [B03]–[B06] here. A one-line note beside each of those two decisions in `briefs/dictation-mic-brief.md`, pointing at this brief, keeps the record honest without rewriting a document an arc has already been walked from.

---

## Open Questions {#open-questions}

- **What `finishing` looks like on the button.** The wave is the live face; a finish is the same wave for up to two seconds, then idle. Whether that reads as "still listening" and needs a distinct face is a spike question if it bothers anyone in use, not one prose settles.

---

## Non-goals {#non-goals}

- **Promoting the volatile tail instead of finishing on the host.** Considered as the cheap route and rejected for the ordinary ends: it keeps the recogniser's provisional guess when its settled reading is one call away. It survives only where the host cannot be waited for ([B06]) and as the deadline's fallback ([B04]).
- **A hold-to-talk chord.** ⌘D is a toggle, matching the button. Push-to-talk stays rejected, as in the first brief.
- **Ending dictation on window blur beyond what app-resign already does.** Resign already covers it.
- **Any change to the wire format's event kinds.** `finish` is a new deck-to-host verb; the host-to-deck union is unchanged.

---

## Exit {#exit}

An arc. A likely order:

1. Host: the `finish` verb in `DictationEngine` — finalize, keep forwarding finals, deadline, then `ended` — with the two adapters' `finish()` no longer cancelling their result readers; the no-audio harness branch answers `finish` with `ended` so app-tests can drive it.
2. Deck: `finishDictation(id)` in the bridge; the store's `finish(reason)` path and `finishing` phase beside `end`; the span's `end` growing a `promote` variant; the composers' synchronous ends switched to it and Escape left alone.
3. `TOGGLE_DICTATION` — action, binding, both responders, tooltip chip.
4. The `focusout` release in both composers.
5. The two notes in `briefs/dictation-mic-brief.md`.
6. App-tests: ⌘D starts and stops from the caret and does nothing without one; a scripted `volatile` then ⌘D keeps the text once the host's `ended` arrives; Escape after a `volatile` drops it; a click on another card ends the session; a `final` pushed during `finishing` still lands.

The host verb comes first because everything on the deck that finishes is waiting on it.
