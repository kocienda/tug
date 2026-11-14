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

**[F12] Nothing here was observed on a real non-US layout.** Every claim about what an AZERTY, Dvorak or Russian keyboard delivers is read from source, not recorded from events. Driving a real layout means switching the machine's keyboard input source.

---

## Decisions {#decisions}

**[B01] A chord names the key that types its character on the user's layout.** This is AppKit's convention [F05], it is what the menu bar and the Keyboard Shortcuts pane already display [F03], and it is what the reporter expected. It reverses the identity sentence in `tuglaws/commands.md` [F02], and that reversal is made in the open: the law is rewritten in the same change.

**[B02] The deck reads the layout from WebKit's `keyCode`, not from a table of its own.** When `event.keyCode` is 65–90 the effective code is `Key` plus that letter; otherwise it is `event.code`. One function in `chord-format.ts` computes it, and `eventChordKey`, `chordMatchesEvent` and `chordFromEvent` go through it, so the global index, the scoped walk and chord capture agree by construction. WebKit's three-step resolution [F06] gives the right answer for AZERTY and QWERTZ, for "Dvorak – QWERTY ⌘", and for non-Latin layouts, where it falls back to position, which is what those users expect of ⌘C. CodeMirror's use of the same field [F08] is the precedent inside our own bundle.

**[B03] The text-editing bindings use the same function.** ⌃U, ⌃W, ⌥F and ⌥B are letter mnemonics like the rest, and a second match rule beside the first is the drift `chord-format.ts` exists to prevent [F01].

**[B04] The forwarded synthetic keydown carries `keyCode`.** Without it a forwarded chord would match by position again [F10].

**[B05] Digits stay positional.** A digit chord fires on the number-row key whatever the layout types there unshifted. This follows Chromium [F09] and is the only workable rule on layouts where a digit needs Shift.

**[B06] Punctuation stays positional in this work.** WebKit derives `keyCode` from the character for "certain punctuation keys" [F06], but which ones was not confirmed, and a wrong guess would move a chord nobody asked to move. A punctuation chord the deck does not match falls through to AppKit [F04], which may have remapped the item [F05]. Revisit once [F12] is answered.

**[B07] The page keeps going first.** The deck goes on matching menu-eligible chords itself, now by the right rule. The sentence in `tuglaws/commands.md` claiming AppKit scans first is corrected to describe what WebKit does [F04].

**[B08] Stored chords, user overrides, the menu push and the displayed labels do not change.** They are already spelled in US terms that read as characters [F03]. No override migration is needed.

**[B09] The unit tests are built from event fixtures for AZERTY, Dvorak – QWERTY ⌘ and Russian.** Each fixture is the `code`, `keyCode`, `key` and modifier set WebKit's source says that layout delivers [F06]. They pin the rule; they do not prove the layouts, which is [F12].

---

## Open Questions {#open-questions}

- **Does a real AZERTY keyboard deliver what the fixtures assume?** [F12]. It cannot be settled from this machine without changing the user's input source. A lab VM with the layout selected, or the reporter trying a build, would settle it.
- **Which punctuation chords land on a different key than the menu shows, on AZERTY and QWERTZ?** About 20 defaults are exposed [F11]. Settling it needs the same recording as the question above, read against what AppKit's automatic localization does to each item. The answer decides whether [B06] stands.

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
