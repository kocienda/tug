# Dictation: a mic in Z5 that speaks prompt content into the composer

**Purpose:** Tug's composers accept prompt content only by typing, pasting, or dropping. A microphone button beside Submit, like ChatGPT's, should let the user speak a prompt instead, with only one composer ever holding the mic.

---

## Purpose {#purpose}

The user's ask: "add a way to speak to create prompt content … a mic icon next to the submit button in Z5 (and in other cards like the Overview), just like ChatGPT does." Two constraints came with it. Tug has no OpenAI services and nothing speech-shaped rides on the Claude credentials, so the recogniser has to be whatever macOS provides. And the mic must be exclusive: "only ever open for one input/prompt area."

The user also settled the OS question at the door: offer dictation on macOS 15 too, through the older recogniser, so there is no feature gap by OS version. "If you're on the older OS, you get what you get."

---

## Evidence {#evidence}

**[F01] Z4B centres itself; a second Z5 button costs no layout rule.** The toolbar row in `tugdeck/src/components/tugways/tug-entry-shell.tsx` (lines 183–201) renders leading, spacer, indicators, spacer, trailing, and the two `flex: 1 1 auto` spacers in `tug-entry-shell.css` (335–380) are what centre Z4B ([D97]). Anything added to Z5 takes width from both spacers equally, so the indicator cluster stays centred in the space between Z4A and Z5 without being pushed. **(verified)**

**[F02] Z5 already holds a second button in one mode.** `TugPromptEntry`'s trailing fragment (`tug-prompt-entry.tsx` 3798–3888) renders a `+` queue button before Submit while a turn is in flight, and Submit itself swaps icon by lifecycle (ArrowUp, Square, wave indicator). A mic that sits before Submit and swaps its own face when live follows an existing shape. **(verified)**

**[F03] The Overview card does not mount `TugPromptEntry`.** It builds its own composer on `TugEntryShell` plus `TugTextEditor` with its own trailing send button (`overview-card.tsx` 1918–1995). A mic added only inside `TugPromptEntry` would miss the Overview, which the user named explicitly. **(verified)**

**[F04] A cross-composer insert seam already exists.** `tugdeck/src/lib/prompt-insert-target.ts` defines `PromptInsertTarget` with `insertText`, `insertAtom`, and `raise`; the Session adapter parks inserts on store slots that the entry drains in layout effects, and the Overview adapter (`overview-insert-target.ts`) binds the editor delegate and parks up to 16 inserts until mount. The append rule for a non-empty draft is `applyAppendInsertion` (`tug-prompt-entry.tsx` 610–617). Dictation can reach both composers through this seam without touching an editor directly. **(verified)**

**[F05] Host to deck is a WKWebView bridge with a request/response idiom to copy.** Deck to host is `window.webkit.messageHandlers.<name>.postMessage`; host to deck is `evaluateJavaScript` on `window.__tugBridge?.onXxx`. Handlers are registered in `tugapp/Sources/MainWindow.swift` (483–501), dispatched at 1692, and torn down near 1228. The open-panel round trip (`choosePath` in Swift, `native-path-picker.ts` in the deck) uses an id-keyed pending map, installs its callback with `??=` so sibling bridge keys survive, and feature-detects the handler so it degrades to nothing in browser dev. **(verified)**

**[F06] Tug.app has never asked for a TCC permission.** `tugapp/Info.plist` carries no `NS*UsageDescription` key. `Tug.entitlements` holds only `allow-unsigned-executable-memory`; the app is not sandboxed but runs under hardened runtime (`ENABLE_HARDENED_RUNTIME = YES`). Microphone capture under hardened runtime needs the `com.apple.security.device.audio-input` entitlement, and the system prompts need `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`. Minimum system is macOS 15.0. **(verified from the plist and entitlements; the entitlement requirement is Apple's documented hardened-runtime rule, not measured here)**

**[F07] The deck already has exclusive-resource stores to model on.** `card-modal-hold-store.ts` keeps one hold per card via `useSyncExternalStore`, carries a reason and a `refuse()` so every door speaks the same refusal ([L31]), lets a second claim replace the first, and keys release on the claim record to defeat stale releases. `open-tooltip-registry.ts` is the "one on screen, ever" module singleton outside React. **(verified)**

**[F08] macOS offers two recognisers, both on-device and uncapped.** macOS 26 ships `SpeechAnalyzer` with `SpeechTranscriber`: on-device, no duration cap, results as an async stream of volatile and finalized segments, language model fetched as an asset on first use. macOS 15 has `SFSpeechRecognizer`, which with on-device recognition required is also uncapped, with partial results delivered by callback. The audio side is `AVAudioEngine` in both cases. ChatGPT's desktop quality comes from OpenAI's own Whisper-family model, which is not available to Tug. **(from API knowledge, not exercised in this checkout; the first spike step should confirm both paths compile and transcribe on the user's machine)**

**[F09] The Web Speech API inside WKWebView is possible and buys nothing.** It works in WKWebView but routes through the older recogniser, needs the same TCC prompts and entitlement, requires the host to grant media-capture permission through `WKUIDelegate` anyway, and gives the deck no control over the audio session or the model. **(inference from the API surface, not measured)**

---

## Decisions {#decisions}

**[B01] The recogniser is macOS's, run in Tug.app, and the deck only ever sees text.** No OpenAI service is reachable, nothing speech-shaped rides on the Claude credentials, and bundling a local Whisper build would carry a model and runtime Tug has no other reason to ship. Swift owns `AVAudioEngine` and the transcriber; the deck receives events over the bridge ([F05]). The Web Speech route is rejected ([F09]).

**[B02] Both OS floors get dictation; the OS decides the quality.** On macOS 26 the host uses `SpeechAnalyzer` and `SpeechTranscriber`; on macOS 15 it uses `SFSpeechRecognizer` with on-device recognition required. Both sit behind one host-side protocol with the same event shape, chosen by availability check. The user's call: no feature gap by version, and on the older OS "you get what you get." Revisit only if the older path proves unable to deliver the volatile/final shape ([B06]) at all.

**[B03] The mic is a toggle in Z5, a sibling before Submit, in every composer.** Tap opens, tap again or Escape closes; the icon swaps to a live level indicator while open, the way Submit swaps to Stop ([F02]). Closing never submits; the text stays in the draft. Z4B needs no adjustment because the spacers centre it ([F01]). Push-to-talk is rejected as a primary gesture: it does not match the reference the user pointed at and fights the keyboard-driven composer.

**[B04] The button is one shared component, mounted by `TugPromptEntry` and by the Overview composer.** Because the Overview does not use `TugPromptEntry` ([F03]), the mic is a small component fed by the dictation store ([B07]) and a `PromptInsertTarget` ([F04]), dropped into each composer's trailing slot. Any later composer takes the same piece. The mic renders only when the host bridge advertises the `dictation` handler, so browser dev shows no button.

**[B05] The bridge follows the open-panel template.** One deck-to-host handler, `dictation`, with `start` and `stop` verbs and an id; one host-to-deck callback, `__tugBridge.onDictation`, carrying the id and one of: `ready`, `preparing` (model asset downloading), `level`, `volatile` text, `final` text, `ended`, or `refused` with a reason (no microphone permission, no speech permission, no model, no input device). Because the host speaks in plain JavaScript, an app-test drives the whole text path by calling the callback with a scripted transcript and never touches a microphone.

**[B06] Live text lands in the document as a dictation span: volatile tail decorated, final text plain.** A CodeMirror state field tracks one range from the caret at open, mapped through every change. Each volatile event rewrites the tail, rendered dimmed so it reads as provisional; each final event settles the tail as plain text and advances the committed edge; close drops the decoration and keeps the settled text. The first insert uses `applyAppendInsertion` so it pads onto a non-empty draft ([F04]). `PromptInsertTarget` grows a dictation handle (begin span, update volatile, commit final, end span) beside `insertText`; the shared button never touches an editor. A ghost line beneath the editor was considered and rejected: the user asked for ChatGPT's behaviour, which writes into the field.

**[B07] Exclusion is enforced twice: the deck arbitrates, the host backstops.** The deck keeps a module singleton dictation store on the model of the card-modal hold store ([F07]): one owner keyed by composer id, `useSyncExternalStore` for the buttons, a claim that moves the mic rather than refusing (tapping the mic in a second composer takes it), release keyed on the claim record. The host keeps one audio engine and one live session id; a `start` while another is live ends the old one and reports `ended` for it, so the host is right even when the deck is wrong. The store's single refusal reason feeds every button's disabled state and tooltip, so all doors say the same thing ([L31]).

**[B08] The store owns the involuntary releases.** Dictation ends, keeping finalized text and discarding the volatile tail, when: the owning card is dismissed or its session goes away; the owner's composer submits or clears; a modal hold lands on the owning card; the app resigns active; the input device disappears; or the host reports `refused` or an error. Each of those tells the host to stop. Most of the real work in this feature is here, not in the button.

**[B09] Permissions are declared once and their refusal is spoken, not silent.** Add `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` to `Info.plist` and `com.apple.security.device.audio-input` to `Tug.entitlements` ([F06]). A denied TCC prompt reaches the deck as `refused` with a reason the button shows; it never leaves a dead mic with no explanation.

---

## Open Questions {#open-questions}

- **Whether the macOS 15 partial-result callback maps cleanly onto the volatile/final event shape.** `SFSpeechRecognizer` reports a growing best transcription rather than segment finalization, so the host may have to synthesize `final` from stability or from the end of the session. The first spike step should try it on a macOS 15 machine or VM; the answer changes only the host adapter, not the protocol.
- **Whether `level` events are worth their cost.** A live level makes the button read as listening, but it is a stream of host-to-deck JavaScript evaluations. A cheap alternative is a fixed "listening" animation driven by CSS, with `level` dropped. Settle during the spike by watching the bridge under a long dictation.

---

## Non-goals {#non-goals}

- **Voice mode.** ChatGPT's second control in the reference screenshot opens a spoken conversation. This work is dictation into the composer only; nothing is spoken back and nothing submits on its own.
- **A bundled speech model.** No Whisper build, no downloaded third-party weights. macOS is the only recogniser ([B01]).
- **The Web Speech API in WKWebView.** Rejected as buying nothing over the bridge ([F09]).
- **Push-to-talk as the primary gesture.** Rejected ([B03]); a hold-to-talk chord can be revisited later without touching the protocol.
- **Voice commands or editing by speech.** Dictation writes text; it does not interpret "delete that" or "submit."
- **Dictation into anything other than a prompt composer.** Text cards, jots, and the commit message editor are out of scope until a composer other than Session and Overview asks for it.

---

## Exit {#exit}

An arc. A likely order:

1. Host side first: the `dictation` handler in `MainWindow.swift`, the two recogniser adapters behind one protocol ([B02]), the plist strings and the entitlement ([B09]), and a throwaway page that prints events, so the audio and permission paths are proven before any deck code exists.
2. The deck bridge module modelled on `native-path-picker.ts` ([B05]), with the scripted-transcript test seam.
3. The dictation store with its claim, replace, release, and involuntary-release rules ([B07], [B08]).
4. The dictation span in the editor and the `PromptInsertTarget` dictation handle ([B06]).
5. The shared button, mounted in `TugPromptEntry` and the Overview composer ([B03], [B04]), with app-tests that drive the callback directly.

Steps 1 and 2 can be taken in either order, but 3 and 4 both need 2, and 5 needs everything before it.
