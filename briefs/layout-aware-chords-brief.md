# Layout-aware chords

**Purpose:** On a non-QWERTY keyboard Tug's shortcuts fire on the wrong keys: the deck matches a chord by the key's physical position while the menu bar shows and matches it by character. This brief records why, what the platform already provides, and the rule Tug adopts.

---

## Purpose {#purpose}

GitHub issue [#171](https://github.com/kocienda/tug/issues/171), "Wrong keyboard mapping for non-qwerty layout", from a user on an AZERTY keyboard:

> I was wondering why some keyboard shortcuts weren't working as excepted (Cmd-Q, Cmd-W), but by doing a mistake (Cmd-A) the app quitted. Then I understood that being on an AZERTY keyboard, all shortcuts are mapped to raw key values (I guess).

The guess is right. The key labelled A on AZERTY sits where QWERTY has Q, so ⌘ with that key quits the app, and ⌘ with the key labelled Q selects all. The menu bar says ⌘Q throughout. The user's direction for the fix was that this is a solved problem on the platform, and Tug should adopt the platform's answer and not invent one.

---

## Evidence {#evidence}

**[F01] The deck matches a chord by physical position.** `eventChordKey` and `chordMatchesEvent` in `tugdeck/src/components/tugways/chord-format.ts` compare `event.code`, and `chordFromEvent` records it. `tugdeck/src/components/tugways/text-editing-keybindings.ts` compares `event.code` on its own for ⌃U, ⌃W, ⌥F and ⌥B. The callers are the global index in `keymap-registry.ts`, the scoped walk in `responder-chain.ts`, and `use-chord-capture.ts`. **(verified, read from the code)**

**[F02] Positional identity is a recorded rule, not an accident.** `tuglaws/commands.md`, under *Chords*: "Identity is `KeyboardEvent.code` plus the four modifier flags." Changing the match rule reverses that sentence. **(verified)**

**[F03] Everything except the match is already character-semantic.** `codeToKeyEquivalent` turns `KeyQ` into the character "q" for the menu push, and `formatChord` displays `KeyQ` as Q. A stored chord therefore already reads as "the key that types Q" to the menu bar and to the Keyboard Shortcuts pane; only the deck's match treats it as a position. **(verified)**

**[F04] In a WKWebView the page sees a ⌘ or ⌃ chord before the menu bar does.** `WebViewImpl::performKeyEquivalent` (WebKit, `Source/WebKit/UIProcess/mac/WebViewImpl.mm`) passes the event to the page and returns YES; its comment reads "This lets webpages have a crack at intercepting key-modified keypresses." Only when the page does not handle it does `WebViewImpl::doneWithKeyEvent` resend it with `[NSApp sendEvent:event]`, which is where the menu bar matches it. This agrees with the issue's symptoms and with what was already known about the shipping app, and it contradicts the sentence in `tuglaws/commands.md` that says "AppKit scans menu-item key equivalents *before the web view sees a keydown at all*". **(verified, read from WebKit's source; `tugapp/Sources` has no `performKeyEquivalent` override that would change the order)**

**[F05] AppKit's convention is that a shortcut is a character, resolved against the current layout.** `NSMenuItem.keyEquivalent` is a string. Since macOS 12, `allowsAutomaticKeyEquivalentLocalization` (default true) remaps a shortcut that is unreachable on the current keyboard, and `allowsAutomaticKeyEquivalentMirroring` (default true) swaps brackets and arrows for right-to-left. Apple's own example is ⌘\ on a Japanese keyboard. The Cocoa Event Handling Guide gives the dispatch order: `performKeyEquivalent:` down the key window's view hierarchy first, then the menu bar. **(verified, from Apple's documentation and the WWDC 2021 "What's new in AppKit" transcript)** Apple does not document how matching behaves on AZERTY, Dvorak or non-Latin layouts specifically; that part is inferred from the convention and from [F06].

**[F06] WebKit already computes a layout-aware key on every event: the legacy `keyCode`.** `windowsKeyCodeForKeyEvent` in `Source/WebCore/platform/mac/PlatformEventFactoryMac.mm` resolves it in three steps, and its comments name each case:

1. `[event characters]` first — "Cmd switches Roman letters for Dvorak-QWERTY layout, so try modified characters first."
2. Then `[event charactersIgnoringModifiers]` — "Ctrl+A on an AZERTY keyboard would get VK_Q keyCode if we relied on -[NSEvent keyCode] below."
3. Then the physical keycode — "the key next to Caps Lock has the same Event.keyCode on U.S. keyboard ('A') and on Russian keyboard (CYRILLIC LETTER EF)."

Its header comment states that Roman letters get the same `keyCode` "on QWERTY, AZERTY or Dvorak layouts". **(verified, read from WebKit's source)** The helper `windowsKeyCodeForCharCode` lives in another file and was not read, so the exact values (65–90 for A–Z) and its treatment of punctuation are taken from the comments and from the long-standing web convention, not from its code.

**[F07] `code` and `key` are the wrong fields for this.** `codeForKeyEvent` is a pure switch on the virtual keycode. `keyForKeyEvent` reads `[event characters]` unless Control is held, so with ⌥ held `key` is the composed character (⌥C arrives as "ç") and cannot name the letter. **(verified, read from WebKit's source)** WebKit has no keyboard layout-map API to lean on; MDN lists `navigator.keyboard.getLayoutMap` as limited-availability, and the Safari row was not read directly.

**[F08] CodeMirror, which Tug ships, uses `keyCode` the same way.** `runHandlers` in `tugdeck/node_modules/@codemirror/view/dist/index.js` tries the name from `event.key`, and when a modifier is held falls back to `base[event.keyCode]`. **(verified, read from the installed package)**

**[F09] Chromium keeps ⌘-digit positional.** `cr_firesForKeyEquivalentEvent:` in Chromium's `ui/base/cocoa/nsmenuitem_additions.mm` treats ⌘ plus a number key as the numeral whatever the layout types there, citing Czech: "we want to interpret cmd + '+' as cmd + '1'." **(verified, read from Chromium's source)**

**[F10] The synthetic keydown the deck forwards to a key view drops `keyCode`.** `responder-chain-provider.tsx` builds a `KeyboardEvent` from `key`, `code` and the four modifier flags only. **(verified)**

**[F11] The default chords are mostly on letters.** In `command-registry.ts`: 57 on letter keys, 2 on digits, about 20 on punctuation (`[`, `]`, `/`, `=`, `-`, `,`, `.`, `'`), the rest on arrows, Tab and Escape. **(verified, counted by grep)**

**[F12] Nothing here was observed on a real non-US layout.** Every claim about what an AZERTY, Dvorak or Russian keyboard delivers is read from source, not recorded from events. Driving a real layout means switching the machine's keyboard input source. **(answered by [F13])**

**[F13] A lab recording now says what five layouts deliver.** `tests/app-test/readings/lab-layout-recording.test.ts` ran in a macOS 27 lab guest with French (AZERTY), German (QWERTZ), Greek, Russian and Dvorak – QWERTY ⌘ selected. It pressed every key a default chord uses, bare, under ⌘, ⌃, ⌥ and ⇧, and under ⌘ with each of ⌃, ⌥ and ⇧, through the harness's pid mode and through the session tap. The two modes delivered the same `key`, `code` and `keyCode` for every press both could make. It is committed as `tugdeck/src/components/tugways/__tests__/fixtures/keyboard-layouts.json`. **(verified, recorded)** What it found:

- Letters arrive as [B02] assumed: AZERTY's US-Q key reports 65 under ⌘, ⌃ and ⌥ (with `key` `æ` under ⌥), Russian and Greek letters report their US position, and Dvorak – QWERTY ⌘ is QWERTY under ⌘, ⌥⌘ and ⌘⇧.
- **Dvorak – QWERTY ⌘ is Dvorak under ⌃⌘.** The US-C key types `j` and reports 74 with ⌃⌘ held, while AppKit's menu still matches ⌃⌘ chords at QWERTY positions. So on that layout a ⌃⌘ letter chord fires in the deck on the key that types its Dvorak letter, and the menu would fire it on the QWERTY one. The event carries nothing that names the ⌘-only remap, so the deck cannot follow the menu here.
- **Punctuation `keyCode` is character-derived on every layout.** A punctuation key reports the code of the US key that carries its character, shifted or not: AZERTY's key labelled `-` (the US Equal position) reports 189, its `=` key (US Slash) 187, and its `<` key 188, the US comma key. AppKit's localized menu fires the punctuation chord on the key that types the character: ⌘ with AZERTY's `-` key reached Zoom Out, and with QWERTZ's `-` key (US Slash) too.
- Under the positional rule this put the deck and the menu at odds on the most-used punctuation chords. On AZERTY, ⌘ with the key labelled `-` fired the deck's ⌘= Zoom In, and ⌘ with the key labelled `=` opened the command picker (⌘/). On QWERTZ, ⌘ with the key labelled `-` opened the command picker. In every case the menu named a different command.
- A letter position can type punctuation: AZERTY's US-M key types `,` and reports 188, and `m` is on the US Semicolon key.

---

## Decisions {#decisions}

**[B01] A chord names the key that types its character on the user's layout.** This is AppKit's convention [F05], it is what the menu bar and the Keyboard Shortcuts pane already display [F03], and it is what the reporter expected. It reverses the identity sentence in `tuglaws/commands.md` [F02], and that reversal is made in the open: the law is rewritten in the same change.

**[B02] The deck reads the layout from WebKit's `keyCode`, not from a table of its own.** When `event.keyCode` is 65–90 the effective code is `Key` plus that letter; a punctuation key follows its character under [B06]; otherwise it is `event.code`. One function in `chord-format.ts` computes it, and `eventChordKey`, `chordMatchesEvent` and `chordFromEvent` go through it, so the global index, the scoped walk and chord capture agree by construction. WebKit's three-step resolution [F06] gives the right answer for AZERTY and QWERTZ, for "Dvorak – QWERTY ⌘" under ⌘, ⌥⌘ and ⌘⇧, and for non-Latin layouts, where it falls back to position, which is what those users expect of ⌘C. The recording [F13] confirmed all of these. Under ⌃⌘ that Dvorak layout types Dvorak, so a ⌃⌘ letter chord follows Dvorak in the deck while AppKit's menu follows QWERTY. That is a known limit, left as it is: the event carries nothing the deck could correct it from. CodeMirror's use of the same field [F08] is the precedent inside our own bundle.

**[B03] The text-editing bindings use the same function.** ⌃U, ⌃W, ⌥F and ⌥B are letter mnemonics like the rest, and a second match rule beside the first is the drift `chord-format.ts` exists to prevent [F01].

**[B04] The forwarded synthetic keydown carries `keyCode`.** Without it a forwarded chord would match by position again [F10].

**[B05] Digits stay positional.** A digit chord fires on the number-row key whatever the layout types there unshifted. This follows Chromium [F09] and is the only workable rule on layouts where a digit needs Shift.

**[B06] A punctuation chord follows its character where the character confirms it.** *Revised once the recording answered [F12]: this decision first kept punctuation positional, and that is reversed in the open here, in `chord-format.ts` and in `tuglaws/commands.md`.* The recording [F13] showed that positional punctuation fires a different command than the menu on AZERTY and QWERTZ. It also showed that WebKit's punctuation `keyCode` names the US key carrying the character, which is the key AppKit's localized menu uses. So `effectiveCode` maps a punctuation `keyCode` (186–192, 219–222) to that US key's code. It takes it only when the character confirms it: `key` must be the character that key types in the event's shift state, or ⌥ must be held and `key` composed. A code shared by both characters on a US key would otherwise match a key it should not: AZERTY's `<` key reports the comma key's 188 and would open Settings on ⌘<. A key whose character does not confirm the code, and a key the layout leaves in place, stay positional as before. Digit positions stay positional under [B05] even when they type punctuation: AZERTY's 4 key types `'` and is still ⌘4. Scored against the recorded menu tries, this removes every case where deck and menu named different commands because of punctuation. What remains is the digits and AppKit's own matching of ⌃⌘⇧ chords. A punctuation chord the deck does not match still falls through to AppKit [F04]. The same rule settles the AZERTY comma key: ⌘ there is ⌘, now, not ⌘M.

**[B07] The page keeps going first.** The deck goes on matching menu-eligible chords itself, now by the right rule. The sentence in `tuglaws/commands.md` claiming AppKit scans first is corrected to describe what WebKit does [F04].

**[B08] Stored chords, user overrides, the menu push and the displayed labels do not change.** They are already spelled in US terms that read as characters [F03]. No override migration is needed.

**[B09] The unit tests read their layout events from the recording.** The fixtures were first built from what WebKit's source says each layout delivers [F06]. They now come from `fixtures/keyboard-layouts.json` [F13] through `fixtures/keyboard-layouts.ts`, so they prove the layouts as well as the rule. The synthesized events, with no `keyCode` or with one set by hand, stay hand-made, because no keyboard sends them.

---

## Open Questions {#open-questions}

- ~~**Does a real AZERTY keyboard deliver what the fixtures assume?**~~ Settled by the lab recording [F13]: it does, for letters under every modifier recorded.
- ~~**Which punctuation chords land on a different key than the menu shows, on AZERTY and QWERTZ?**~~ Settled by the same recording [F13]. Zoom In, Zoom Out and the command picker landed on different keys, so [B06] was revised to follow the confirmed character.

---

## Non-goals {#non-goals}

- **A host-built layout table.** An earlier sketch had Swift read the layout with `UCKeyTranslate`, push a key-to-character table to the deck, and push again on every input-source change, to each body web view. WebKit already computes the same answer per event [F06], so the table would be a second implementation of something the platform ships.
- **Matching on `event.key`.** It is the modern field, but with ⌥ held it is the composed character [F07], so every ⌥ chord would stay positional.
- **Giving the menu bar first shot with a `performKeyEquivalent` override.** It would hand every menu chord to AppKit's matching, punctuation included. It also flips precedence: every scoped binding that shadows a menu chord today would stop doing so, and that needs an audit of its own. Letters are fixed without it [B07].
- **Opting out of AppKit's automatic key-equivalent localization.** It stays on. It is the fallback that catches what the deck does not match [B06].
- **Per-layout default keymaps.** No chord is re-authored for a layout.

---

## Exit {#exit}

**An arc.** The first steps, in the order they should land:

1. Add the effective-code function to `chord-format.ts` and route `eventChordKey`, `chordMatchesEvent` and `chordFromEvent` through it, with the fixture tests of [B09] beside it. `ChordEventFields` gains `keyCode`.
2. Move `text-editing-keybindings.ts` onto the same function [B03].
3. Carry `keyCode` on the forwarded synthetic keydown in `responder-chain-provider.tsx` [B04].
4. Rewrite the identity paragraph and the "AppKit first" sentence in `tuglaws/commands.md`, and the `KeyboardEvent.code` comments on `Chord` and `KeyBinding` that repeat the old rule [B01] [B07].
5. Reply on issue #171 once a build carries the change, asking the reporter to confirm ⌘Q, ⌘W and ⌘A and to try a few punctuation chords, which answers both open questions.
