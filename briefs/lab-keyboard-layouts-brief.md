# Lab keyboard layouts: an input-source verb and a recorded layout spike

**Purpose:** The `layout-aware-chords` fixes for issue #171 rest on event fixtures taken from WebKit's source rather than recorded from a real non-US keyboard. We need a way to drive AZERTY, QWERTZ, Greek, Russian and Dvorak – QWERTY ⌘ honestly, without changing the user's own keyboard.

---

## Purpose {#purpose}

The `layout-aware-chords` arc (`briefs/layout-aware-chords-brief.md`) moves chord matching from physical position to WebKit's layout-aware `keyCode`. That brief leaves two questions open, and both need a real non-US layout. The first is whether AZERTY and the others deliver the `key`, `code` and `keyCode` its fixtures assume ([F12] there). The second is which punctuation chords land on a different key than the menu shows, which decides whether its [B06] stands.

Neither can be settled on the user's Mac, because driving a layout means switching the input source the whole login session shares. The question asked was whether a lab VM can stand in: "Can we properly simulate AZERTY/QWERTZ/Greek/Russian keyboards in a lab/VM setting?" The answer is yes. This brief records how, and what has to be built first.

---

## Evidence {#evidence}

**[F01] The harness already posts keys the way a physical keyboard does.** `postKeyEvent` in `tugapp/Sources/TestHarness/NativeEventHandlers.swift` builds `CGEvent(keyboardEventSource:virtualKey:keyDown:)` from a virtual keycode, which names a key position. It stamps the modifier flags and never sets a Unicode string. The event goes out through the session tap, or through `postToPid` under `TUGAPP_NATIVE_EVENT_MODE=pid`. **(verified, read from the code)** Because no Unicode string is set, the system fills in the event's characters from the keyboard layout. That is the path a hardware key takes, and it is where AZERTY and the other layouts take effect. That the translation uses the *current* input source for both posting modes was inferred from Core Graphics' documented behaviour. **(confirmed by the spike: across five layouts, pid mode and the session tap delivered the same `key`, `code` and `keyCode` for every press both could make. The session tap loses ⌃⌘D and ⌥⌘D to the system.)**

**[F02] The harness names keys by their US position.** `VirtualKeyMap` (`tugapp/Sources/TestHarness/VirtualKeyMap.swift`) maps a name such as `"q"` to the US keycode for Q, and `nativeKey` looks keys up there. **(verified)** Under AZERTY, `nativeKey("q", ["cmd"])` presses the key that types "a". For a hardware test that is correct behaviour, but a layout test has to say which physical key it means. The ASCII typing verb (`nativeType`) would type the wrong characters under any non-US layout.

**[F03] The input source is global to the login session.** Selecting one changes the keyboard for every app the user is running, and it stays changed until something selects another. **(verified, platform behaviour; it is why the `layout-aware-chords` session declined to switch the user's machine)**

**[F04] A Tart VM lab exists, but it runs installs, not app-tests.** `scripts/lab/` and the `lab-*` recipes in the `Justfile` clone golden bases (`base-sequoia`, `base-tahoe`, `base-golden-gate`) into throwaway runs, boot them with a share mounted, and install a `Tug.dmg`. `scripts/lab/golden-run.md` describes onboarding checks run by hand. Nothing there runs `bun` or the app-test harness inside a guest. **(verified)** The harness *does* depend on a Debug build. `TestHarnessBridge` attaches when its socket environment variable is set, but only inside `#if DEBUG` (`tugapp/Sources/AppDelegate.swift`), so a release or DMG build cannot host a test. *(Corrected 2026-11-14. This finding first said any build could host the harness, and the code says otherwise.)*

**[F05] Harness teardown already resets per-connection input state.** When a connection closes, `TestHarnessConnection.swift` calls `releaseAllHeldModifiers()` so a test that throws cannot leave Shift held. **(verified)** An input-source restore belongs at the same point, for the same reason.

**[F06] App-test selection already honours tags that change where a file may run.** `tests/app-test/scripts/select-tests.ts` reads `@alone` and `@motion` from a file's header and queues those files apart. **(verified)** No tag yet excludes a file from host runs entirely.

**[F07] AZERTY and QWERTZ boards are usually ISO.** ISO has an extra key beside left Shift and a different Return shape, and the keyboard type changes how some keycodes translate. Core Graphics lets an event source set its own keyboard type. **(read by the spike: the Golden Gate guest's `LMGetKbdType` is 198, a virtual board that is neither ANSI 40 nor ISO 41. French and German were recorded with the harness's type set to ISO, the others under the guest's own.)** This affects punctuation and the extra ISO key, not letters.

---

## Decisions {#decisions}

**[B01] The layouts are driven for real inside a lab guest, not simulated.** The harness selects the actual input source and posts keys by position [F01]. Every layer then does exactly what it does for a hardware keyboard: the system's translation, WebKit's `keyCode` derivation, and AppKit's menu matching with its macOS 12 key-equivalent localization. A simulated table could not reach the last of those, and it would repeat the mistake the `layout-aware-chords` brief made when it rejected a host-built table.

**[B02] A harness verb selects an input source by ID and restores the previous one at teardown.** It takes an ID such as `com.apple.keylayout.French`, `German`, `Greek`, `Russian` or `DVORAK-QWERTYCMD`. It enables the source if the guest has not enabled it yet, selects it, and returns the ID it replaced. The connection remembers the first source it replaced and selects it again when it closes, beside `releaseAllHeldModifiers` [F05], so a test that throws cannot leave the guest on AZERTY. The exact ID spellings are read from the guest's own source list when the verb is built, not from this list.

**[B03] The verb refuses to run outside the lab.** The input source is session-global [F03], so on the user's Mac the verb would change their keyboard during a run. It acts only when the app was launched with a lab flag in its environment, which the lab's app-test launch sets and a host run never does. The flag is `TUG_LAB=1`. `scripts/lab/guest-app-test` is the only thing that sets it, and it reaches the app through the harness's forwarding of every `TUG*` variable. Otherwise it throws an error naming the flag. A refusal is a red the user sees. Silently ignoring the call would let a layout test pass while measuring US.

**[B04] A test can name a key by position.** The harness gains a way to press a key by its `KeyboardEvent.code` name, `KeyQ` for example, with modifiers, beside the existing name lookup [F02]. Layout tests are written in physical keys ("the key at `KeyQ`, which is labelled A on AZERTY"). That is what a user's finger does, and it keeps the test's meaning independent of `VirtualKeyMap`'s US names. `nativeType` stays ASCII-on-US, and a layout test does not use it.

**[B05] The event source can declare an ISO keyboard type.** The layout verb, or a sibling, sets the harness event source's keyboard type, so the extra ISO key and punctuation translate as they would on a European board [F07]. Before relying on it, the spike reads the guest's default type.

**[B06] Lab-only app-tests carry a new `@lab` tag that host selection never picks.** `app-test-changed`, `app-test-select`, the core tier and `app-test-all` on the host skip every `@lab` file [F06], and a lab run selects them. This keeps an AZERTY test from ever reaching the user's machine through `@covers`.

**[B07] The spike's recording becomes the fixtures.** In a guest, for each of French (AZERTY), German (QWERTZ), Greek, Russian and Dvorak – QWERTY ⌘, the spike presses every key the default chords use (letters, the two digits, the ~20 punctuation keys), both bare and under ⌘, ⌃ and ⌥. For each press it records the deck's `key`, `code`, `keyCode` and modifier flags. It also records, for each punctuation chord, whether AppKit's localized menu fires it and on which key. The output is a committed data file, and the `layout-aware-chords` unit tests read their fixtures from it, replacing the values derived from WebKit's source. That answers both of that brief's open questions. If the recording contradicts its [B02] or [B06], the correction is made in that brief and its code in the open, never by re-pointing its tests.

*[B07] as built:* the spike is `tests/app-test/readings/lab-layout-recording.test.ts`, run with `just lab-app-test golden-gate --fetch …`, and `scripts/lab/layout-recording-fixture.ts` turns its two recordings into `tugdeck/src/components/tugways/__tests__/fixtures/keyboard-layouts.json`. It also records ⌘ with each of ⌃, ⌥ and ⇧, because the defaults hold those pairs and Dvorak – QWERTY ⌘ turned out to differ under ⌃⌘. To learn which menu item a key reaches without performing it, it uses a harness probe, `menuKeyProbe`. While armed, the probe enables every item and records each menu action instead of sending it. It never presses ⌘⇧ or ⌃⌘ on the key where ⌘ types `q`, or ⌘⇧3–6. Those are system shortcuts the probe cannot withhold, and the first run logged its guest out on Dvorak's ⌘⇧Q. The recording contradicted the layout-aware-chords brief's punctuation decision, and that brief's [B06], its `effectiveCode` and `tuglaws/commands.md` were revised in the open. Its letter rule stood; its one Dvorak – QWERTY ⌘ sentence was narrowed to ⌘, ⌥⌘ and ⌘⇧.

**[B08] One lab-only app-test then pins the reported bug.** Under AZERTY, ⌘ plus the key at `KeyA` (labelled Q) reaches Quit, and ⌘ plus the key at `KeyQ` (labelled A) selects all and does not quit. Quit is observed through the app's quit path, not by letting the harness app exit mid-test; how is the test's detail. The same file may cover ⌘C under Russian falling back to position, if that costs no more than a second case.

**[B09] This work follows the `layout-aware-chords` join.** The verb and the tag can be built on any base. The spike and the app-test only mean something against the fixed matching rule, and the user will join that arc first.

---

## Open Questions {#open-questions}

- **How does a guest run app-tests?** *Settled 2026-11-14 by doing it:* `just lab-app-test <os> [--keep] [files…]` (`scripts/lab/lab-app-test` and `scripts/lab/guest-app-test`, written up in `scripts/lab/app-test-run.md`). The host-built Debug app-test bundle and the working tree cross into a fresh clone as archives in one read-only share. Reading `node_modules` file by file over virtiofs exhausts the guest's file handles, so nothing runs from the share. The tree is unpacked at the bundle's `BuildSourceTree` path, because tugcast panics on a bootstrap workspace that does not exist. The guest gets the host's `bun` and `just` and the release bundle's static `tmux`. Accessibility and event posting are granted by writing the system TCC database, which the bases' disabled SIP allows. The ordinary `just app-test` then runs there with `TUG_LAB=1`. `harness-smoke/smoke-native-cmd-a.test.ts` ran green in a Golden Gate 27.0 guest.
- ~~**Does `postToPid` translate through the current layout the same way the session tap does?**~~ *Settled by the spike:* it does [F01], so layout tests use the default pid mode.

---

## Non-goals {#non-goals}

- **Switching the input source on the user's Mac, even briefly or with a restore.** The keyboard is shared with everything the user is running [F03], and a crashed run would leave it switched. [B03] makes this mechanical rather than a convention.
- **A synthetic layout table in the harness.** Computing characters with `UCKeyTranslate` and building `NSEvent`s by hand would avoid the guest. But it skips the system's own translation and AppKit's key-equivalent localization, which are the parts in question [B01].
- **Input methods.** Japanese, Chinese and Korean composition is a different pipeline from layout translation, and issue #171 does not involve it.
- **Physical-hardware facts.** How a real ISO keyboard is detected, and the user's own keyboard-type setting, are outside what a VM can show. A reporter trying a build covers those.
- **Making the lab part of `just ci`.** Lab runs are by hand, like the golden runs.

---

## Exit {#exit}

An arc, opened after `layout-aware-chords` joins [B09]. A likely order:

1. Make a guest run one existing app-test end to end (the first open question), and write the lab recipe that does it, setting the lab flag of [B03].
2. Add the input-source verb with its teardown restore and lab refusal [B02] [B03], press-by-position [B04], and the keyboard-type setter [B05], with the TypeScript wrappers.
3. Add the `@lab` tag to selection, with tests showing host selection never picks such a file [B06].
4. Run the spike in a guest, commit the recording, and move the `layout-aware-chords` unit fixtures onto it [B07]. If the punctuation readings contradict that brief's [B06], resolve it there.
5. Add the AZERTY app-test [B08].
