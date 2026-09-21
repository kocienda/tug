<!-- brief-skeleton v1 -->

# Non-modal app updates

**Purpose:** An app update should never interrupt what the user is doing. Tug's update flow still ends in Sparkle's modal windows, and its one non-modal piece — a 30-second bulletin — disappears; replace the whole presentation with an in-window pill and popover in the manner of Ghostty, keeping Sparkle's engine.

---

## Purpose {#purpose}

The prompt, from `briefs/sparkle-non-modal-notes.md`: Ghostty's author had a Sparkle dialog pop up in the middle of a keynote demo, decided that should never happen again, and replaced Sparkle's UI with a small overlay tucked into a corner of the application window. Clicking it opens a lightweight popover carrying the available version, release notes, download/install progress, install/restart controls, and errors — "all without interrupting whatever you're doing." The properties asked for:

- never steals keyboard focus
- never interrupts the workflow
- always visible if you care
- ignorable if you don't
- looks like part of the app instead of a system dialog

Updates are "important information, but not an emergency." The ask is to bring that full experience to Tug.

---

## Evidence {#evidence}

**[F01] Tug is halfway there, and only for scheduled checks** — `tugapp/Sources/UpdateController.swift` owns an `SPUStandardUpdaterController` (Sparkle 2.9.4, per `Package.resolved`) and implements `SPUStandardUserDriverDelegate` with gentle reminders: a scheduled find is declined (`standardUserDriverShouldHandleShowingScheduledUpdate` returns false when `onScheduledUpdateFound` is set) and handed to `AppDelegate.announceUpdate` → `MainWindow.bridgeUpdateAvailable` → `window.__tugBridge.onUpdateAvailable`, which `tugdeck/src/lib/update-bridge.ts` renders as a bulletin. **(verified)**

**[F02] Everything after the click is Sparkle's modal flow** — the bulletin's "Update..." action posts to the `checkForUpdates` message handler (`MainWindow.swift`), which calls `AppDelegate.checkForUpdates` → `updaterController.checkForUpdates(nil)`. Release notes, download progress, install, relaunch and errors are all Sparkle's standard windows. A user-initiated check (the app-menu item) never touches the deck at all. **(verified)**

**[F03] The non-modal piece is not persistent** — the bulletin is a toast with `duration: 30_000` and, by its own docblock, "no store, no React state, and nothing persisted." After 30 seconds nothing on screen says an update exists; the "always visible if you care" property is missed. **(verified)**

**[F04] Two pieces of `UpdateController` are load-bearing and independent of the user driver** — the consent floor (`controller.updater.automaticallyDownloadsUpdates = false`, set after start, with the comment recording a release bundle that installed unattended), and the postponed relaunch (`shouldPostponeRelaunchForUpdate` stores Sparkle's handler; `AppDelegate` releases it via `resumePostponedRelaunch` at the very end of termination so the new instance never races the old one's children for sockets and ports). Both are `SPUUpdater` / `SPUUpdaterDelegate` surface, not standard-driver surface. **(verified)**

**[F05] Sparkle's `SPUUserDriver` protocol is the sanctioned seam, and its full surface is known** — read from `Sparkle/SPUUserDriver.h` in the 2.9.4 checkout. The non-deprecated methods: `showUpdatePermissionRequest:reply:`, `showUserInitiatedUpdateCheckWithCancellation:`, `showUpdateFoundWithAppcastItem:state:reply:`, `showUpdateReleaseNotesWithDownloadData:`, `showUpdateReleaseNotesFailedToDownloadWithError:`, `showUpdateNotFoundWithError:acknowledgement:`, `showUpdaterError:acknowledgement:`, `showDownloadInitiatedWithCancellation:`, `showDownloadDidReceiveExpectedContentLength:`, `showDownloadDidReceiveDataOfLength:`, `showDownloadDidStartExtractingUpdate`, `showExtractionReceivedProgress:`, `showReadyToInstallAndRelaunch:`, `showInstallingUpdateWithApplicationTerminated:retryTerminatingApplication:`, `showUpdateInstalledAndRelaunched:acknowledgement:`, `dismissUpdateInstallation`, `showUpdateInFocus`. Every user decision is a stored reply closure (`SPUUserUpdateChoice` install / dismiss / skip), a cancellation closure, or an acknowledgement closure. **(verified)**

**[F06] "Later" at ready-to-install means install-on-quit** — the header's discussion of `showReadyToInstallAndRelaunch:` says a reply of `SPUUserUpdateChoiceDismiss` "dismisses the update installation for the time being. Note the update may still be installed automatically after the application terminates," and that `Skip` at this stage cancels the in-progress update without skipping the version in future. **(verified** in the header; the runtime behaviour under Tug's postponed relaunch has not been exercised.**)**

**[F07] The appcast carries no release notes today** — `tugrust/scripts/make-appcast.sh` hands `generate_appcast` a directory of archives and a `--link`; nothing in it writes a notes file beside an archive. `generate_appcast` embeds notes only when a same-named `.html`/`.md` sits next to the archive — that convention is from Sparkle's documentation and was not re-read here. **(script verified; convention is recollection)**

**[F08] The window already hosts one native corner overlay** — `MainWindow.setDevInfo` pins a `DevInfoOverlayView` to the web view's bottom-left, shown in maker mode only. The upper right of the deck canvas holds no native overlay. Whether deck-level chrome already occupies the upper right was not surveyed. **(first half verified)**

**[F09] A local end-to-end path exists** — `TUG_SPARKLE_FEED` bypasses the bundle-identity gate and supplies the feed URL, so the whole update path can be driven against a locally served appcast from any build. **(verified)**

**[F10] No test covers the update path in the deck** — a search for `update-bridge`, `onUpdateAvailable` and `checkForUpdates` under `tests/` and `tugdeck/src` finds only `update-bridge.ts` itself and its install call in `main.tsx`. **(verified)**

---

## Decisions {#decisions}

**[B01] Tug implements its own `SPUUserDriver` and stops using `SPUStandardUpdaterController`.** `UpdateController` constructs a bare `SPUUpdater` with a `TugUpdateDriver`; Sparkle's engine, feed, signature verification and installer are untouched. This is the only route to the asked-for experience — the gentle-reminder delegate [F01] can defer Sparkle's *first* window but cannot replace the ones behind it [F02]. The cost, stated by Sparkle itself, is that Tug becomes responsible for presenting every state in [F05] correctly; the decisions below are shaped to keep that tractable. The consent floor and the postponed relaunch [F04] carry over unchanged.

**[B02] Native owns the flow; the deck owns the look.** The driver is a state machine living in the host: each protocol callback is a transition, and it holds Sparkle's reply closures. The states are `idle`, `checking` (cancellable), `available` (version, build, release notes), `downloading` (received, expected), `extracting` (progress), `readyToInstall`, `installing`, `upToDate`, and `error`. The reducer — event in, snapshot out — is kept separable from the Sparkle glue so it can be unit-tested without Sparkle. Presentation lives in the deck because that is where Tug's themes, markdown rendering and component vocabulary are; a native pill would be the one unthemed surface in the app and would need its own release-notes renderer.

**[B03] One snapshot goes out; one action comes back.** The host publishes `__tugBridge.onUpdateState(snapshot)` on every transition and replays the current snapshot on `bridgeFrontendReady`. Because what crosses the bridge is *state* and not an *event*, a deck reload is idempotent and needs no queue. The deck replies through a single message handler, `updateAction`, with one of `install`, `later`, `skip`, `cancel`, `retry`, `dismiss`, `check`; the driver maps each onto whichever stored closure the current state holds, and ignores an action the current state has no closure for.

**[B04] The deck UI is an `updateStore` plus a pill that opens a popover, and the pill sits in the upper right of the deck canvas.** The position is the user's call. The store enters React through `useSyncExternalStore` [L02]. The pill is absent in `idle`, reads as a down-arrow and version when an update is available, and carries a thin progress underline while downloading and extracting. Clicking it opens a popover with the version, the release notes rendered by the deck's markdown renderer in the current theme, progress, and the controls the current state allows. It is deck-level chrome above the canvas, so it may overlap a card parked in that corner; Ghostty accepts the same trade, and the pill exists only while there is something to say.

**[B05] Progress is appearance.** Download and extraction progress is written to a CSS custom property on the pill and popover, never to React state [L06]. The driver publishes progress only when the whole-percent value changes, so the bridge carries at most about a hundred progress snapshots per download.

**[B06] Nothing in the update flow ever takes focus.** No state change opens the popover, moves keyboard focus, or raises a window. The single exception is `showUpdateInFocus` during a *user-initiated* check, where the user has just asked to see the answer: the popover opens. A scheduled find only makes the pill appear.

**[B07] The app-menu item is a second, deck-independent door.** Its title tracks the driver's state — "Check for Updates…", then "Update to Tug <version>…", then "Install and Relaunch" — and choosing it replies to Sparkle directly from the host. Two reasons: a release that ships a broken deck must not also break the only way past it, and a glyph is never a feature's only door. This is what buys the native alternative's resilience without its costs.

**[B08] The popover says the Tug-specific things Sparkle never could.** *Install and Relaunch* names any sessions that are mid-turn, since the relaunch ends them and the deck knows which they are. *Later* at `readyToInstall` replies `dismiss`, which leaves the update to install on the next quit [F06], and the popover says so. `upToDate` dismisses itself after a short interval (acknowledging to Sparkle as it goes). `error` persists in a caution tone, with Retry, until the user dismisses it.

**[B09] The permission prompt is never shown.** `SUEnableAutomaticChecks` is set in the Info.plist so Sparkle does not ask, and the driver's `showUpdatePermissionRequest:reply:` answers affirmatively in code as the floor. A modal "check automatically?" on second launch is the same interruption this work exists to remove; downloads still require an explicit click [F04].

**[B10] The bulletin path is deleted, not bridged.** The install base is zero, so there is nothing to stay compatible with. Removed: the bulletin in `update-bridge.ts` and `onUpdateAvailable`, `UpdateController.onScheduledUpdateFound`, the `SPUStandardUserDriverDelegate` extension, `AppDelegate.announceUpdate` / `flushPendingUpdateNotice` / `pendingUpdateNotice`, `MainWindow.bridgeUpdateAvailable`, and the `checkForUpdates` message handler (subsumed by `updateAction`'s `check`).

**[B11] Release notes become part of a release.** The release workflow writes a notes file beside each archive so `generate_appcast` embeds it [F07]; the driver passes what `showUpdateReleaseNotesWithDownloadData:` delivers (or the item's inline description) into the `available` snapshot. When notes are missing or fail to download, the popover shows the version and controls without them — an absent notes file never blocks an update.

**[B12] Testing is three layers, none of which needs the network.** Swift unit tests for the reducer [B02]; a bun test for the store; and one app-test that injects snapshots through `__tugBridge.onUpdateState` and asserts the pill, the popover, and the `updateAction` messages posted back [F10]. The app-test carries `@covers` lines for the new deck files and the bridge. The true end-to-end run stays manual, against a local appcast via `TUG_SPARKLE_FEED` [F09].

---

## Open Questions {#open-questions}

- **Does the upper right of the deck canvas already have a tenant?** [F08] did not survey deck-level chrome. If something lives there, the pill needs an inset or an ordering rule; reading the deck's canvas chrome settles it.
- **What produces the release-notes file?** [B11] says the release workflow writes one; whether its content is hand-written per release, or derived from the commit log between tags, is a call about how releases are authored, and is the user's.
- **How does install-on-quit interact with the postponed relaunch?** [F06] is the header's word. When the user picks *Later* and later quits normally, Sparkle installs after termination with no relaunch — `shouldPostponeRelaunchForUpdate` should simply never fire, but this has not been run. One manual pass against a local appcast settles it.

---

## Non-goals {#non-goals}

- **A fully native pill and `NSPopover`.** Considered: it matches Ghostty exactly and survives a broken deck by construction. Rejected because it would be the app's one unthemed surface, needs its own release-notes renderer, and the menu item [B07] buys the same resilience for far less.
- **A title-bar accessory.** Ghostty's author tried this first and abandoned it after repeated layout fights; the in-window overlay was the conclusion. Not re-running that experiment.
- **Automatic background downloads or silent installs.** The consent floor [F04] stands; this work changes how an update is *presented*, never whether the user is asked.
- **Replacing Sparkle, or touching the feed, signing, or delta machinery.** The engine is kept whole; only the user driver changes.
- **A nightly or debug update feed.** Eligibility stays as it is: the stable identity, or a `TUG_SPARKLE_FEED` override.
- **A compatibility bridge for the old bulletin.** [B10] — zero installs means a clean break.
- **A generalized host-status pill framework.** One tenant does not earn a framework; if a second host-level status ever wants the corner, that is the time.

---

## Exit {#exit}

**An arc.** The work has a natural order, because each layer is testable before the next exists:

1. The reducer and `TugUpdateDriver` in the host, with `UpdateController` switched to a bare `SPUUpdater`, the consent floor and postponed relaunch carried over, and the app-menu item tracking state [B01] [B02] [B07] [B09]. At this point the menu alone can drive a whole update against a local appcast — the deck-independent door is proven first.
2. The bridge: `onUpdateState` out with replay on frontend-ready, `updateAction` in [B03].
3. The deck: `updateStore`, the upper-right pill, the popover and its per-state controls, progress through a CSS property, the mid-turn sessions line [B04] [B05] [B06] [B08].
4. The deletions [B10], landed with the step that replaces each thing rather than saved for the end.
5. Release notes in the release workflow [B11], independent of the rest and landable at any point.
6. The app-test and the manual end-to-end pass, which also settles the install-on-quit question [B12].
