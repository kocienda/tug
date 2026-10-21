<!-- brief-skeleton v1 -->

# App-tests run quietly: the foreground audit and the beep tripwire

**Purpose:** Too many app-tests take the screen, and many beep as they run. Only a test whose subject is activation, or whose events cannot be delivered any other way, may come to the front; no test may beep. The corpus has drifted from both, and this brief records what drifted, why, and what holds the line afterwards.

---

## Purpose {#purpose}

The user's report, 2026-10-21:

> It feels like many app-tests run in the foreground when they probably don't need to. The only app-tests which come to the front are the ones which *must must must* have the foreground to function properly (i.e. because the CG Event interface doesn't work, or the test is *all about* testing an app that is actually in the foreground). It feels like the constraints here have loosened considerably so that any old app-test feels like it's special and can seize the foreground. No. We need to grab control back here. We need a full audit of the entire app-test suite and reset the tests so they run as quietly and unobtrusively as possible.
>
> Also, while on the topic of unobtrusiveness, many app-tests now beep repeatedly as they run, and it drives me out of my mind. Those beeps must go away.

Two complaints, one standard: a run happens around the user, never at them. A window that takes focus and a speaker that beeps are both the run reaching out of its lane.

---

## Evidence {#evidence}

**[F01] The written rule is still tight; the practice is not.** The launch option's doc in `tests/app-test/_harness/types.ts` says `foreground: true` is for tests "whose SUBJECT is activation — key-window status, app resign / become-active, responder-chain routing that AppKit gates on being active", and `tests/app-test/README.md` says the same. 38 of 448 test files declare `@foreground` today, and by their own docblocks only about ten fit that sentence. **(verified, read out of the code)**

**[F02] The loosening agent is a second doctrine in the harness header.** The header of `tugapp/Sources/TestHarness/NativeEventHandlers.swift` says: "Pid mode is never evidence for a chord or a menu command. A test of either launches `foreground: true` (session mode)." That sentence turned every ⌘A, ⌘C, ⌘V and ⇧⌘O test into a screen-taker: fifteen files cite "a chord needs a key window" or "the pasteboard wants a key window" as their whole reason. The doctrine is also not followed: 95 background files post ⌘ chords through `nativeKey(…, ["cmd"])` in pid mode and pass. **(verified by census)**

**[F03] The second driver is occlusion, not activation.** WebKit suspends `requestAnimationFrame` in a covered window, and the pid-mode harness window is placed one level below normal and ordered back (`AppDelegate.swift`, `MainWindow.harnessBackgroundLevel`), so every paint or motion reading went foreground to get a viewport. Twelve files say so in their docblocks: the four at0629 motion-render-cost files, at0645, at0677–at0680, at0737, at0744, at0746, at0747. They needed a visible window, not an active one. **(verified, read out of the code and docblocks)**

**[F04] The lifecycle verbs force a foreground launch by construction.** `simulateAppResign` / `simulateAppBecomeActive` / `simulateAppHide` / `simulateAppUnhide` drive `NSApp.deactivate()` and a Finder activation, and the selection script already demands the launch option for any file calling them. Seven files call one: at0014, at0018, at0148, at0295, at0306, at0647, at0677. **(verified)**

**[F05] The 38 declarations sort into five buckets.**

| Bucket | Files | Count |
|---|---|---|
| Activation is the subject | at0165, at0148, at0295, at0213, at0175 | 5 |
| Calls a lifecycle verb | at0014, at0018, at0306, at0647, at0677 | 5 |
| "A chord or the pasteboard needs a key window" | at0174, at0188, at0229, at0269, at0280, at0352, at0376, at0418, at0466, at0474, at0477, at0526, at0528, at0619, at0748 | 15 |
| Needs an unoccluded viewport | at0629 (×4), at0645, at0678, at0679, at0680, at0737, at0744, at0746, at0747 | 12 |
| No reason stated | at0145 | 1 |

The honest floor is the first two rows, about ten files, pending the check in [B06]. **(verified by reading each docblock)**

**[F06] No test asserts a beep.** Every mention of "beep" in the corpus (at0140, at0145, at0169, at0174, at0181, at0212, at0352) is a "never beeps" guard or a comment about AppKit eating a chord. So zero beeps per file can be a hard rule with no exemptions. **(verified by grep)**

**[F07] The likely beep sources are all pid-mode shapes; which one is loud is not yet measured.** Three candidates, from the code and its comments:

- A ⌘ chord whose menu item validates dark. AppKit eats a key equivalent on a disabled item and beeps (`MenuBarBuilder.swift` says so in four places). In an accessory app with no key window, Edit-menu items validate against nothing, so ⌘C and ⌘V beep in the background even when the page would have handled them. This is the same fact that pushed the chord bucket foreground.
- A bare key with no responder. 80 background files post Tab, Escape or an arrow; one that reaches a window with no first responder ends in AppKit's no-responder beep.
- A key posted before the window is ready. `tests/app-test/_harness/tolerances.ts` names this as the reason for `STATE_SETTLE_MS`.

The ⌃⌘-arrow writing-direction beep is already closed by the registered default in `AppDelegate.swift`. **(inference; the tripwire in [B03] is what confirms it)**

**[F08] There is no per-process switch for the alert sound.** `NSBeep` is an AppKit-internal symbol and AppKit calls it directly, so an import rebind in the main executable cannot catch it. The sound it plays goes out through AudioToolbox, a different image, so AppKit reaches it through a stub that a fishhook-style rebind can replace. **(inference from how the frameworks are linked; the first spike proves or disproves it)**

**[F09] The harness already has the no-activation ordering primitive.** `orderWindowFrontInactive()` in `NativeEventHandlers.swift` calls `orderFrontRegardless()`, which reorders without activating; it is used today only for the one `activateFirst: false` click. **(verified)**

---

## Decisions {#decisions}

**[B01] A test comes to the front only for one of two reasons, and names which.** Either activation is its subject, or it calls a lifecycle verb that cannot run in an inactive app. Nothing else earns the screen: not a chord, not the pasteboard, not a viewport. This is the user's standard restated, and it is what [F01] already said before [F02] loosened it.

**[B02] The `@foreground` tag carries a reason from a closed list, and the lint rejects any other.** `@foreground activation` or `@foreground lifecycle`. The check in `tests/app-test/scripts/select-tests.ts` (`--foreground-check`) rejects a bare tag, an unknown word, and a `lifecycle` tag on a file that calls no lifecycle verb. The check joins `just lint` so a new screen-taker cannot land unannounced. The existing two-way drift check (tag without launch option, launch option without tag) stays.

**[B03] A beep is a red.** The test-mode harness rebinds the AudioToolbox alert-sound entry that `NSBeep` reaches, so the sound never plays and every call is counted with a stack and the last harness verb. A file that beeps fails, and the run summary's `Failures:` section names the verb that caused it. Silence is the default, not a per-test option, because [F06] shows no test wants a beep. If the rebind cannot catch AppKit's call ([F08] disproved), the fallback is attribution without silencing, and the fixes still go to the causes in [F07].

**[B04] The fixes for beeps go to the cause, never to the symptom.** A dark menu item releases its chord instead of eating it (the `disabledChord` gate already exists for this); a test waits for a responder before posting a bare key; the launch settle stays ahead of the first key. The tripwire finds them; the arc fixes what it finds.

**[B05] A new visible tier sits between background and foreground.** A `visible: true` launch option and a `@visible` tag: the window at normal level, ordered front without activation, never key, so the user keeps keyboard and cursor and only sees a window. In test mode the WKWebView's occlusion detection is turned off through WebKit's private SPI, which the user has accepted for test mode; where that holds, the visible tier needs no ordering at all and the window stays below normal and still renders. The twelve files in [F05]'s viewport row move there. If the SPI turns out not to keep rAF running, the tier falls back to the no-activation ordering in [F09].

**[B06] The chord bucket moves to the background once a pid-mode window can be key without activation.** The first spike tries `makeKey` on the harness window under the accessory policy. If an accessory app can hold a key window, Edit-menu validation has a first responder to read, the chords stop beeping, and the fifteen files drop `foreground: true`. If it cannot, the pasteboard tests are rewritten to drive the copy and paste through the menu item's action or the bridge rather than the chord, and still leave the foreground. Either way, the header paragraph in [F02] is rewritten to say what the spike proved.

**[B07] at0175 is re-pointed at the focus state it is after.** The user decided this. CM6 paints a caret only under real DOM focus, which an inactive app never has, so the assertion moves from "a caret is painted" to the focus state the mount is supposed to produce: the editor is the active element and the card's focus-manager state names it. The test leaves the foreground.

**[B08] The harness header doctrine is rewritten.** The paragraph "Pid mode is never evidence for a chord or a menu command" goes. Its replacement states which events pid mode delivers faithfully, which it does not, and the one evidence rule that survives: a test of *WindowServer* routing or of activation itself is foreground; everything else is not.

**[B09] Every moved file is verified alone, after its last edit, per `tugtool apptest history`.** No 20-file union. The at0629 family and the rail-drag family carry the highest risk of a hidden occlusion dependency, so they are the files to watch rather than the chord files.

---

## Open Questions {#open-questions}

- **at0145's reason.** Its docblock states none. Its "(deactivated) editor" line means a disabled editor, not app deactivation, so it most likely belongs in the background. The arc reads the file and either gives it an `activation` reason or moves it; this is not a user decision.
- **Whether `makeKey` works under the accessory policy.** [B06] branches on it, and only the spike answers.

---

## Non-goals {#non-goals}

- **Silencing the speaker at the user level.** No `defaults write`, no system volume, no alert-sound preference. Those are the user's settings, and a per-machine change to hide a test-suite defect is the wrong lane.
- **An activation-free rewrite of the ten genuine screen-takers.** A test of resign and become-active has to resign and become active. The ten keep the screen; the arc only makes sure the number is ten.
- **A per-test "allow beeps" option.** [F06] shows nobody wants one, and an option would be the next loosening.
- **Retiring the countdown dialog.** The dialog that warns before screen-takers run stays as it is; this work reduces how often it has anything to warn about.

---

## Exit {#exit}

**An arc.** Its first moves, in the order they have to land:

1. The spikes, in a scratch harness file that ships nothing: the AudioToolbox rebind ([B03]), `makeKey` under the accessory policy ([B06]), and the WebKit occlusion SPI ([B05]).
2. The beep tripwire landed in the harness and the run summary, then a core-tier run to read which of [F07]'s causes is loud, and the cause-level fixes ([B04]).
3. The visible tier: launch option, tag, lint, and the twelve viewport files moved onto it.
4. The reasoned `@foreground` tag and its lint ([B02]), applied to the ten keepers and at0145.
5. The chord bucket and at0175 off the foreground ([B06], [B07]), one file at a time, each verified alone ([B09]).
6. The header rewrite ([B08]) and the README section, in the same change as the last file to move.
