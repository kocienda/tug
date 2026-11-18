<!-- brief-skeleton v1 -->

# Launch hand-off for a shared-identity Tug

**Purpose:** When two copies of Tug with the same identity are on disk and one is running, macOS can launch the other, which shows "Another release-main instance is already running" and leaves the user short of the card or file they asked for. The second copy should hand off to the running one and quit.

---

## Purpose {#purpose}

A local Release build on `main` (`just app-release`) and a Tug installed from the DMG are the same app to macOS: bundle ID `dev.tugapp.app`, instance `release-main`. The README ("Several Tugs at once") says the sharing is deliberate, and it stays, because the user's live sessions and settings are in `release-main`.

When both copies are on disk and one is running, anything macOS routes by bundle ID can launch the other copy: a click on a session notification, a Dock or Spotlight launch, a file open. That second copy hits the instance guard and shows the alert from `promptDuplicateInstanceTakeover` in `tugapp/Sources/ProcessManager.swift`.

The report, 2026-11-17: clicking a session notification posted by the running `~/Library/Developer/Xcode/DerivedData/Tug/Build/Products/Release/Tug.app` (0.9.4) launched a second Tug, believed to be `/Applications/Tug.app` (0.8.19). The user worked around it by deleting the `/Applications` copy.

What is wanted: a copy that starts and finds its instance already running brings the running Tug forward, passes along what it was launched for, and quits without the alert.

---

## Evidence {#evidence}

### The incident

**[F01] The notification click was delivered to the running copy, and it worked.** At 17:32:30 PST on 2026-11-17 `usernoted` logged `Notifying UserNotifications client dev.tugapp.app:54045 about response …`; pid 54045 was the running DerivedData host, and its tugcast logged `focus-session-card` 5 ms later. Read from `/usr/bin/log show` and `tugcast.log.2026-11-18` in the `release-main` instance's `Logs/`. The same pair repeats at 17:35:20. **(verified)**

**[F02] The second copy was a side effect of macOS fronting the app by path.** Immediately after [F01], `usernoted` logged `Bringing app dev.tugapp.app front for response with URL: file:///Applications/Tug.app/`; 190 ms later a new `dev.tugapp.app` process (pid 55113) checked in with LaunchServices and its tugcast was refused with exit 73. The second copy carried no intent and received no `UNNotificationResponse`. **(verified)**

**[F03] The launched copy was `/Applications/Tug.app`.** The URL in [F02] names it. It wrote no `launch:` laps to `tugapp.log`, which fits a build older than the one that added them. **(verified for the path; the version is inferred)**

### How the guard works today

**[F04] The host detects nothing itself; the guard is tugcast's, and it fires late.** `applicationDidFinishLaunching` in `tugapp/Sources/AppDelegate.swift` builds the window, activates, opens tugbank, starts the updater, begins `WebCachePurge` and calls `processManager.start`. tugcast's `bind` in `tugrust/crates/tugcast/src/boot/bind.rs` then finds a live entry for its `TUG_INSTANCE_ID` through `tugcore::registry::find_by_id` and exits 73. `ProcessManager` reads exit 73 within one second as the collision and shows the alert, whose default button stops the incumbent through `tugtool host instance stop`. **(verified, read from the code)**

**[F05] The registry already carries what a hand-off needs.** `$TMPDIR/tug-instances.json` holds, per instance, `instance_id`, `bundle_path`, `host_pid`, `pid` (tugcast's) and `tugcast_port`. `ProcessManager.readRunningPID` already reads it in Swift, without a liveness check. An entry appears only once the first copy's tugcast is up, about 1.2 s after launch. **(verified)**

**[F06] A refused tugcast overwrites the running instance's bundle-path marker.** Its log shows `bundle-path marker written` (`tugcast::boot::early`) immediately before `duplicate-launch refused`, so after the incident `release-main`'s marker named the other copy's path. **(verified from the log; the write site was not read)**

**[F07] The colliding host touches shared state before it knows it is a duplicate.** By the order in [F04] it opens the live `tugbank.db`, starts the updater and runs `WebCachePurge` against the running instance's data. **(verified from the code order; no damage was observed)**

**[F08] The existing channels.** `POST /api/tell` on the registry's port is loopback-only and forwards unmatched actions to the shell page, the same road the host's `sendControl` uses for `focus-session-card` and `open-file`; a tell with no page to answer is dropped and logged. The per-instance notify socket (`InstanceConfig.notifySocketPath`) is tugbank's change-notification channel, and the control socket is the host's listener for its own tugcast. `GET /api/pages` lists connected pages with a `role`, `shell` among them. **(verified)**

**[F09] The host already queues OS file opens for a deck that has not loaded.** `openFilesFromOS` filters with `OpenableFiles.isOpenable` and appends to `pendingOpenPaths` until `frontendHasLoadedOnce`, then `flushPendingOpenPaths` sends them. **(verified)**

**[F10] Tug has no `applicationShouldHandleReopen`, and no window-restoring code on activation.** The notification click handler in `tugapp/Sources/SessionNotifier.swift` calls `NSApp.activate()` and sends `focus-session-card`. **(verified)**

**[F11] Tug runs under the hardened runtime with no `apple-events` entitlement.** `codesign -d --entitlements` on the running Release bundle shows `flags=0x10000(runtime)`; `tugapp/Tug.entitlements` holds only `allow-unsigned-executable-memory` and `audio-input`. **(verified)**

**[F12] `just app-release` quits the prior instance before launching.** It runs `tugrust/scripts/quit-tug-bundle.sh` first and opens the built bundle by path. Xcode Run and a Finder launch do not pre-quit. **(verified)**

**[F13] App-test bundles have their own bundle ID and a unique instance per launch.** `dev.tugapp.app.apptest`, instance `apptest-<uuid>` through the `TUG_INSTANCE_ID` override gated on `TUGAPP_TEST_SOCKET`; the harness launches with `open -n` and `--env`. **(verified)**

### Probe measurements

Taken 2026-11-17 on macOS 27.0.1 with a throwaway app under its own bundle ID, one copy in `/Applications` and one under DerivedData, driven by `open`. The probe was not hardened and not Developer ID signed. Each result below is from one to five runs.

**[F14] `/Applications` wins on location, whatever the version.** An 8.19 copy there was launched over a 99.0 copy in DerivedData. With no `/Applications` copy, the higher version won, regardless of registration order. **(verified)**

**[F15] A running copy elsewhere does not stop the launch.** With the DerivedData copy running, a launch by bundle ID, by bundle ID with a file, and by name each started a second process from `/Applications`. With the `/Applications` copy running, the same three reused it and the file reached it; only an explicit open of the DerivedData path started a second process. So the collision is one-sided: it needs the running Tug to be the local build and a second copy in `/Applications`. The Dock and Spotlight were not driven directly. **(verified for `open`; inferred for the Dock and Spotlight)**

**[F16] File URLs arrive before `applicationDidFinishLaunching`.** `application(_:open:)` preceded it in every launch-with-file, five of five, cold and as a second copy. **(verified)**

**[F17] `yieldActivation(to:)` then `activate()` fronts the first copy from the second.** The first copy became frontmost about 80 ms after the second began launching. A hidden app was unhidden. A minimised window stayed minimised: the app became active with nothing on screen. **(verified)**

**[F18] `NSWorkspace.open(urls, withApplicationAt:)` on the running copy's path delivers the file to the running process and fronts it.** Three of three runs, including from a copy whose activation policy was accessory. A minimised window still stayed minimised. **(verified)**

**[F19] `NSWorkspace.openApplication(at:)` on the running copy's path, with no file, resolved to the caller itself.** Two of two runs; the first copy was not activated. **(verified)**

**[F20] A reopen Apple Event restored the minimised window in the probe.** It was sent without a consent prompt and the first copy un-minimised. Given [F11] this does not transfer to Tug: under the hardened runtime it needs an entitlement and may raise a consent prompt. **(verified for the probe; untested for Tug)**

**[F21] An accessory second copy resigns activation at once.** Its file open still worked ([F18]); `yieldActivation` plus `activate()` from an accessory copy was not tested. **(verified as far as stated)**

---

## Decisions {#decisions}

**[B01] The shared identity stays.** A local Release build on `main` keeps bundle ID `dev.tugapp.app` and instance `release-main`. The user's live sessions and settings are there, and the README's account of the sharing stands. This is the user's decision and the premise of everything below.

**[B02] A copy that finds its instance already running hands off and quits.** It creates no window, opens no tugbank, starts no updater, purges no cache and spawns no tugcast. This removes the alert for the case in the report and, by [F07], the shared-state side effects for new builds.

**[B03] The decision is made before `AppDelegate` exists, from the registry, by instance ID.** `main.swift` reads the entry for `InstanceConfig.instanceId` and requires that `host_pid` is alive, is not this process, and is running from the entry's `bundle_path`. No HTTP probe is needed. When the test passes, the app runs with a small separate hand-off delegate; otherwise it launches normally. The lookup is by instance ID and not bundle ID because app-test launches share one bundle ID across many instances ([F13]).

**[B04] The hand-off is not gated on the bundle path differing.** A same-path second launch (`open -n`) gets the same treatment. It is simpler, and it is what lets an app-test exercise the hand-off with one bundle.

**[B05] Files travel through LaunchServices to the running copy's own path.** The hand-off delegate collects `application(_:open:)` URLs, which by [F16] are in hand by `applicationDidFinishLaunching`, and calls `NSWorkspace.open(urls, withApplicationAt:)` on the registry's `bundle_path` ([F18]). The running host receives them in its own `application(_:open:)`, where [F09] already covers a deck that has not loaded. This works against a running copy of any version and puts nothing new on the wire.

**[B06] A plain launch fronts the running copy with `yieldActivation(to:)` and `activate()` on `host_pid`.** Measured in [F17]. `openApplication(at:)` is not used, by [F19].

**[B07] The hand-off copy does not wait for a notification response.** By [F01] and [F02] the running copy already has the click and the second copy never receives one. The hand-off delegate may install the notification delegate and forward a response if one arrives in its short life; `focus-session-card` is idempotent, so a duplicate is harmless.

**[B08] The hand-off copy stays a regular app.** Its life is about 100 ms, so its Dock tile is brief, and the accessory variant of [B06] is untested ([F21]).

**[B09] Today's alert is the fallback, and exit 73 stays as the backstop.** If the registry test in [B03] does not pass, the copy launches normally and reaches tugcast's guard and `promptDuplicateInstanceTakeover` unchanged. If the hand-off itself fails after the test passed, the copy logs one line, still tries to front the running Tug, and quits; a second alert there helps nobody.

**[B10] tugcast writes the bundle-path marker only after the duplicate-launch guard has passed.** By [F06] a refused launch must not rewrite the running instance's marker. This lands with the hand-off and is worth having on its own, because the fallback path in [B09] still spawns a tugcast that can be refused.

**[B11] The running copy restores a minimised main window when an intent reaches it.** On a file arriving through `application(_:open:)` and on a notification click, the host un-minimises its window before fronting. By [F17], [F18] and [F10] nothing does this today. This is a change to the running copy, so it helps only when that copy is a new build.

**[B12] A plain-launch hand-off asks the running copy to raise itself with a small tell routed to the host.** After [B06], the hand-off copy posts a `raise` action to the registry's `tugcast_port`; the running host un-minimises and fronts its window. An older running copy drops the unknown action and stays as [B06] left it. The reopen Apple Event is not used, by [F20] and [F11]. How a tell reaches the host today was not read; see Open Questions.

**[B13] Xcode Run of a Release build on `main` loses the takeover prompt.** With an unconditional hand-off it focuses the running Tug where it used to offer "Quit Other & Continue". `just app-release` is unaffected ([F12]), and `tugtool host instance stop release-main` remains the explicit takeover. This is the default taken on the model's recommendation; the user was asked and moved on to the build without objecting, so it is recorded as taken and is cheap to revisit with an escape hatch such as a modifier held at launch.

**[B14] The hand-off is off for `apptest-*` instances unless a test opts in.** An explicit environment variable, set only by the test that exercises the hand-off, turns it on. Every other app-test launch behaves exactly as today.

**[B15] The work is tested in four layers.** A Foundation-only decision function (registry entry, own pid, liveness, bundle path in; proceed or hand off out) in the `TugTests` bundle; a Rust test for the marker ordering of [B10]; one opt-in app-test that launches a second copy of the same bundle with the same `TUG_INSTANCE_ID` and a file argument and asserts the second process exits 0 within a couple of seconds, a Text card for the file appears in the first, and no second tugcast was spawned; and a by-hand pass on the real app for what the harness cannot see (see Exit).

---

## Open Questions {#open-questions}

- **How does a tell reach the host process today?** [B12] assumes a `raise` action can ride an existing road from tugcast to the host over the control socket. `dispatch_action` in `tugrust/crates/tugcast/src/actions.rs` has host-directed actions (`relaunch` among them), but the road was not traced. Reading it settles whether [B12] is a new action on an existing path or needs a new message type.
- **Does [B06] hold on the real app across Spaces and full screen?** The probe covered a plain, hidden and minimised window on one Space. A Tug on another Space or in full screen is checked by hand.
- **Do the Dock and Spotlight behave as `open` did?** [F15] is measured for `open` by ID, by name and by path, which are the two routes those launchers take, but neither was driven. Checked by hand with both copies installed.

---

## Non-goals {#non-goals}

- **A separate bundle ID for a local Release build.** Rejected by the user: the live sessions and settings are in `release-main` ([B01]).
- **Steering which copy macOS launches.** By [F14] it prefers `/Applications` on location and there is no supported lever; unregistering a copy from LaunchServices is a hack that does not survive the next launch.
- **Waiting in the second copy for a `UNNotificationResponse`.** None is coming ([F02]).
- **A reaper in the running copy that terminates older copies lacking the hand-off.** It kills another process, races the alert by a few hundred milliseconds and loses a file-open intent. Updating the installed copy once has the same effect. An old installed copy keeps today's alert; its code cannot be changed.
- **Carrying intent over `/api/tell`.** `open-file` and `focus-session-card` would work that way ([F08]), but a tell to a deck that has not loaded is dropped, and [B05] gets the host's own queue for nothing. The one tell this work adds is `raise` ([B12]).
- **`NSWorkspace.openApplication(at:)` for the plain launch.** It resolves to the caller ([F19]).
- **A reopen Apple Event, and the entitlement it would need.** Untested under the hardened runtime and may raise a consent prompt ([F20], [F11]).
- **Changing how two different instances coexist.** `debug-main` beside `release-main` never matches the lookup in [B03] and runs side by side as today.
- **Fixing the updater for a stale installed copy.** With a local build running, the old `/Applications` copy never finishes launching, so its updater never gets a turn. The user updates or removes that copy by hand.

---

## Exit {#exit}

**An arc.** The pieces, in the order they should land:

1. **The decision function and the hand-off delegate** ([B02]–[B09], [B13], [B14]): the registry read with liveness in a Foundation-only source with its unit tests, the branch in `main.swift`, and the delegate that collects file URLs, opens them on the running copy's path, fronts it and quits.
2. **The marker ordering in tugcast** ([B10]), with its Rust test. It lands with the first piece.
3. **The opt-in app-test** ([B15]) over the first piece.
4. **The minimised window** ([B11], [B12]): un-minimise on file arrival and notification click in the running host, then the `raise` tell once the first open question is read.

After the arc, by hand, with a hand-off build installed in `/Applications` and a local build running, then the reverse: a notification click, a Dock click on each tile, a Spotlight launch, a file opened from Finder, a minimised window, and a Tug on another Space and in full screen. Expected in each: no alert, no lingering second Dock tile, the running Tug frontmost on the right card or file.
