# App-tests in the background with a real key window

**Purpose:** The 86 body-grounding bar files, and ten more, still take the screen because their keys must arrive "the way a real keyboard sends them." The user's standard is that app-tests must run in the background while fully simulating a foreground app. The one AppKit fact pid mode lacks is a real key window, and a measured way to have one without activating exists.

---

## Purpose {#purpose}

The user, 2026-10-21: "We *MUST* find a way to deliver keyboard events to app-tests while they are in the background in a way that completely and fully simulates the manner of a foreground app. As it is, app-tests are far too disruptive to me using the computer. These tests *must* run in the background."

The `app-test-quiet-run` arc (`afd018ef7`) left 96 `@foreground` files, and its audit (`trusty-pipe`) said: 86 of them are the body-grounding bar's, kept in front by the bar's own rule that a row is green only on WindowServer's routing, and "this arc now gives background runs the same shortcut order a focused window has, so the bar could move to the background too." The question handed over was whether, and how, the bar can leave the foreground without losing what its rule protects.

---

## Evidence {#evidence}

**[F01] The bar reads nothing that pid mode withholds.** A census of `tests/app-test/body-grounding/` shows the rows drive 103 `nativeKey`, 35 `nativeType`, 30 `performMenuItem`, 32 `captureBurst` and 4 `nativeClick`, and assert in a body's DOM, the shell's store, the pasteboard or a window composite. Every fixture seeds `hasFocus: true`; the keyboard is read through `keyboardInCardHost` (`tests/app-test/_harness/selectors.ts`), which is `activeElement` containment and the engine's marks. The only `document.hasFocus()` read in the directory is inside a diagnostic string (`_row-12.ts:269`). No row calls a lifecycle verb or reads `windowState`. **(verified, by grep)**

**[F02] The bar's foreground launch is its rule, not a dependency.** `tests/app-test/body-grounding/README.md` says every file launches `foreground: true` because "a row is green only on WindowServer's own routing," and `briefs/body-view-grounding-brief.md` [B04] says the same: "the pid mode stays for what it is for and is never used to assert a chord." That doctrine predates the quiet-run arc's finding ([F02] there) that 95 background files post chords in pid mode and pass. **(verified, read)**

**[F03] What pid mode lacks is one AppKit fact: a real key window.** `AppDelegate.swift:360-372` calls `window.makeKey()` in pid mode and records that AppKit refuses it to an inactive app — `isKeyWindow` false, `NSApp.keyWindow` nil (measured 2026-10-21 by that arc). Every other difference from the foreground follows from the refusal: `-[NSApplication sendEvent:]` offers a ⌘ chord to the menu before the views (hence `harnessChordMonitor`, `:384`), a nil-target Edit action resolves against nothing (hence `sendToKeyChain`, `:1560`), and WebKit's `WindowIsActive` bit stays off, so `document.hasFocus()` is false, no window `focus` event fires, and `.cm-focused` and the caret never paint. **(verified, read and measured below)**

**[F04] Overriding the accessors alone satisfies WebKit but not AppKit.** In a throwaway accessory app (`/tmp/keyspike/main.swift`, not shipped), an `NSWindow` subclass returning `isKeyWindow` true, or an `NSApplication` subclass returning the window from `keyWindow`, each made `document.hasFocus()` true and fired the page's window `focus` event — WebKit reads either — but a ⌘A through `NSApp.sendEvent` never reached the page in any variant, and a nil-target `selectAll:` resolved to nothing: AppKit's chord routing and `targetForAction` read AppKit's internal key-window state, not the accessors. **(verified, measured 2026-10-21)**

**[F05] An `isActive` override lets the real `makeKey()` succeed, with no activation.** With only `NSApplication.isActive` overridden to true on an accessory app, `window.makeKey()` set the real `isKeyWindow` and `isMainWindow`, the window delegate's `windowDidBecomeKey` and `windowDidBecomeMain` fired, `NSWorkspace.frontmostApplication` stayed the user's app, and a ⌘A through `NSApp.sendEvent` reached the page view-first (`kd:a+meta`) by AppKit's own routing. `NSApp.keyWindow`'s real accessor still returned nil while inactive. **(verified, measured; `/tmp/keyspike/act.swift`)**

**[F06] Nil-target actions consult the `keyWindow` accessor.** Under [F05], `NSApp.sendAction(sel, to: nil)` did not reach a custom first responder while the accessor returned nil, and did once an override returned the window when it was really key. **(verified, measured; `/tmp/keyspike/act2.swift`)**

**[F07] WebKit flips `document.hasFocus()` on its own under the real key window, within about two seconds.** It read false 1.5 s after `makeKey()` and true 0.3 s later with no event between; a key event or a first-responder cycle also had it true. The exact trigger was not found; the posted key notification alone did not do it. **(verified, measured; the trigger is inference)**

**[F08] A real key window in an inactive app does not pull the user's keyboard.** From an AX-trusted process, a Shift down/up posted to the session event tap was not received by the inactive app's local event monitor either before or after its window was really key, and the frontmost app was unchanged. **(verified, measured once; `/tmp/keyspike/steal.swift`)**

**[F09] Mouse events through `NSApp.sendEvent` reach the page in either regime.** A rebuilt `leftMouseDown`/`Up` with the window's number, handed to `NSApp.sendEvent`, was seen by the page with the app inactive and no activation followed. The refusal `NativeEventHandlers.swift:305` describes is WindowServer's frontmost routing of session-tap events, not `sendEvent`. **(verified, measured)**

**[F10] Rendering and capture below everything are already solved.** `MainWindow.keepRenderingWhenCovered` (`MainWindow.swift:620`) turns off WebKit's occlusion detection in the visible tier, and `captureOwnWindowImage` (`:2832`) reads the window server's own composite of the window by id, which the quiet-run arc showed needs no ordering change. **(verified, read)**

**[F11] The ten non-bar foreground files split by what they read.** `at0145`, `at0165`, `at0213` read `document.hasFocus()` or the painted caret as their subject; `at0014`, `at0018`, `at0148`, `at0295`, `at0306`, `at0647`, `at0677` drive `simulateAppResign`/`BecomeActive`/`Hide`/`Unhide`, which call `NSApp.deactivate()`, a Finder activation and `NSApp.activate` (`AppLifecycleHandlers.swift:80-120`). `at0295` additionally clicks with `activateFirst: false` to model the activating click. **(verified, read)**

**[F12] The host learns of activation by delegate callback.** `applicationDidBecomeActive`/`DidResignActive` (`AppDelegate.swift:793-803`) send the lifecycle to the deck, and `replayLifecycleState` (`:868`) reads `NSApp.isActive`; `MainWindow.swift:1470` reads it too. Under [F05] no real activation ever happens, so nothing calls the delegate. **(verified, read)**

---

## Decisions {#decisions}

**[B01] In pid mode the app believes it is active, and the window is really key.** A DEBUG `TugApplication: NSApplication` subclass becomes the principal class (`tugapp/Sources/main.swift`, `NSPrincipalClass` in `tugapp/Info.plist`); under `AppDelegate.harnessPidMode` its `isActive` returns true and its `keyWindow`/`mainWindow` return the harness window when it really is key or main. The existing `window.makeKey()` then succeeds with AppKit's own internal state ([F05]), nil-target actions resolve ([F06]), and WebKit reads the window active ([F04], [F07]). This is the default for pid mode, not a launch option: it is what a foreground app is, and the only tests it would mislead are those whose subject is real activation, which [B05] handles. The user's keyboard stays theirs ([F08]).

**[B02] The two pid-mode hacks retire.** `harnessChordMonitor` and `sendToKeyChain` both guard on `NSApp.keyWindow == nil`, so they go dead by construction under [B01] and are then deleted. Chords take `-[NSApplication sendEvent:]`'s key-window order and Edit actions take `targetForAction`'s chain walk — the app's own path, not a stand-in for it.

**[B03] Activation is announced in-process.** After `makeKey()` the host runs its `applicationDidBecomeActive` path and posts `NSApplication.didBecomeActiveNotification` ([F12]), so the deck's `data-app-active`, the lifecycle replay and the host's `isActive` readers agree. Launch settle in pid mode waits on `document.hasFocus()` in the shell ([F07]) rather than on time. Mouse events are handed to `NSApp.sendEvent` instead of `window.sendEvent` ([F09]) so monitors and `sendEvent` overrides see them as they would a click.

**[B04] The bar's rule is rewritten, not weakened, and the 86 files move.** A row is green on AppKit's own routing with a real key window and first responder. The one hop not simulated is WindowServer choosing the destination process — addressed by `postToPid` instead of frontmost — and a `postToPid` event enters `sendEvent` as the same `NSEvent`, which no in-process code can distinguish. The bar's README, `briefs/body-view-grounding-brief.md` [B04]'s rule as it is carried in `NativeEventHandlers.swift`'s header, and `tuglaws/app-test-harness.md` say so. The 86 files drop `foreground: true` and `@foreground activation`; the `@foreground` lint stays for whatever remains. The pid-mode window keeps `harnessBackgroundLevel` and `orderBack`, with occlusion detection off by default ([F10]), so the 32 `captureBurst` rows read frames where they are.

**[B05] Lifecycle is simulated under the fake, as a second stage.** `simulateAppResign` in pid mode flips the fake inactive, resigns key and runs the resign path; `BecomeActive` the reverse; `Hide`/`Unhide` likewise; the `activateFirst: false` click flips the fake active before dispatch, as AppKit's activating click would. The three `hasFocus`-subject files ([F11]) move with the bar; the seven lifecycle files move once the verbs exist. This is a separate stage because the bar needs none of it, and because it simulates AppKit's behaviour where [B01] merely lets AppKit's own run.

**[B06] Each moved file is verified alone, and the known reds leave the batch.** Per `tugtool apptest history`, after the file's last edit; `row-17-crossing-kinds-resize` and `row-17-crossing-bullseye-in`, red since 2026-10-20, are named rather than re-run. The beep tripwire stays armed: a chord the fake-active AppKit still eats shows up there first.

**[B07] The keyboard is proven not stolen, every run.** A native smoke pins `windowState` (`isKeyWindow`, `appKeyWindow`, `isActive` all true) and `NSWorkspace.frontmostApplication` unchanged across a launch, and a pid-mode-only probe posts a `flagsChanged` to the *session* tap and asserts the app never receives it ([F08]). A Shift is harmless wherever it lands. If either ever fails, [B01] is wrong and the fallback is the accessor-only override of [F04] with [B02]'s hacks kept.

---

## Open Questions {#open-questions}

- **What triggers WebKit's recompute?** [F07] saw it flip within ~2 s with no event. If the trigger is found (a first-responder cycle or a `flagsChanged` both had it true), launch settle can use it; otherwise it waits on `document.hasFocus()`.
- **Does a real key window touch text input services?** A key window with a first responder activates its `NSTextInputContext`; whether that changes the user's input source while another app is front was not measured. The smoke reads `TISCopyCurrentKeyboardInputSource` before and after.
- **Does dictation (row-05 ⌘D) consult real activation?** One row; the first run answers it.

---

## Non-goals {#non-goals}

- **A non-activating `NSPanel`.** It gets key status without activation by asking WindowServer for the user's keyboard, which is the disruption this work exists to end.
- **Faking only the accessors.** [F04]: WebKit is satisfied, AppKit's routing is not, and the two stand-in hacks would stay. Kept only as [B07]'s fallback.
- **A second login session or a VM.** Full fidelity at the cost of a build, grants and a session per run; unnecessary once [B01] holds.
- **Keeping a foreground remnant for "true WindowServer routing."** The hop not simulated is unobservable in-process ([B04]); a test of it would test the operating system.
- **Changing what the rows assert.** The bar's assertions stay; only the launch and the rule move.

---

## Exit {#exit}

An arc. First the `TugApplication` subclass and the principal-class wiring with the smoke and the session-tap probe ([B01], [B07]), then the in-process activation announcement and the settle ([B03]), then the hacks removed ([B02]), then the 86 bar files and the three `hasFocus` files moved one at a time and verified alone ([B04], [B06]) with the README, the harness header and the law rewritten in the same change as the last file; the lifecycle verbs and their seven files last ([B05]). The throwaway spikes under `/tmp/keyspike/` are the measurements, not code to carry over.
