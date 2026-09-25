# Wizard downloads: a frozen deck, a real bar, and a pause that keeps its bytes

**Purpose:** While `UpdateTug` or `ConfigureTug` is up, the menu bar can still open and close cards behind the modal; the steps that move bytes report a bare percent or nothing; and a slow download cannot be paused without throwing away what has already arrived. Fix all three so the two wizards are honest about what the app is doing and never hold a user hostage to a transfer.

---

## Purpose {#purpose}

The user's notes, verbatim:

> - When either of these dialogs is showing, I *should not* be able to change the number of cards on the deck. Menu options like *About Tug* and all the *File* menu options that can open or close cards should be grayed out.
> - We should add *download progress bars* for all the card steps that do downloads. We should use a determinate progress bar if we can (look in the gallery for ProgressIndicators) and indeterminate (barber pole) if we must. There should be excellent progress for the user.
> - All the download features should have a pause/resume feature. This could be especially helpful in UpdateTug. We don't want to block the user on a slow download. Allow them to pick up later if they wish.

Three asks, one surface family. `UpdateTug` and `ConfigureTug` are siblings: both borrow `TugAlert`'s app-modal chrome, both hang `TugStepRow` checklists in it, and both have steps whose whole job is to move bytes from the network onto the machine. What follows treats them together and says where they differ.

---

## Evidence {#evidence}

**[F01] The wizards block the deck but not the menu bar.** Both wizards are Radix `AlertDialog`s portalled into the canvas overlay (`tug-alert-overlay` / `tug-alert-content`, z-index 99990/99991), so pointer input and focus are trapped. AppKit is not. File ▸ New Session is `@objc newSessionCard` in `tugapp/Sources/AppDelegate.swift`, which posts a bare `show-card` control and has **no entry in the command registry at all**; New Text File, New Jot, Open File, Open Quickly, Open Recent, Close and Close All Tabs reach the deck the same way. Nothing in `tugdeck/src/lib/host-menu-state.ts` or in `validateMenuItem` reads "an app modal is open," so ⌘N while a wizard is up opens a Session card behind it. **(verified, by reading; not yet reproduced live)**

**[F02] Enablement has two tiers, and both need the fact.** Per `tuglaws/menus.md`, every gate is a `validateMenuItem` branch: the registry tier reads `menuState.commands[<identifier>]`, and what is not mirrored falls through to hand-rolled cases. Close, Close All Tabs and Open Quickly are mirrored with `validate` predicates; New Text File, Open File and Clear Menu are registry entries with no predicate; New Session, About, Settings and Keyboard Shortcuts are host-owned (the latter three gate on `frontendReady`, tier 3); Open Recent's entries are built in `menuNeedsUpdate` (tier 5). So a deck-side gate reaches some items and a wire field must reach the rest. **(verified)**

**[F03] A disabled menu item eats its chord with a beep.** `tuglaws/menus.md`, "Chords: four layers": dimming does not let the chord fall through. For this work that is the wanted behaviour — ⌘N under a wizard should beep, not open a card — so no chord detaching is needed. **(verified)**

**[F04] Two app-modals can stack today.** `ConfigureTug` suppresses itself under `TugVersionGate` (Spec S02 of an earlier brief; `deriveConfigureTugOpen` in `tugdeck/src/lib/macos-support.ts`), but `UpdateTug` (`tugdeck/src/components/tugways/update-tug.tsx`) and `ConfigureTug` know nothing of each other: Tug ▸ Configure Tug… is live while an update wizard is open, and the update pill and Tug ▸ Check for Updates… raise the update wizard over an open setup wizard. **(verified)**

**[F05] `ConfigureTug`'s open state is derived in render, not held in a store.** The required wizard opens from `authStore`, `claudeVersionStore`, `hostToolsStore` and the version gate through `deriveConfigureTugOpen`; only the on-demand door has a store (`configure-tug-request-store`). `UpdateTug`'s open flag is in `update-tug-request-store` (`useUpdateTugOpen`), written only by the component. There is no single reading of "some app-modal is up." **(verified)**

**[F06] Progress crosses as a whole percent and is painted onto a span, never a bar.** `tugapp/Sources/UpdateState.swift` keeps `receivedBytes`/`expectedBytes` out of the snapshot on purpose and publishes only when the whole percent moves ([B05] of the non-modal brief). `tugdeck/src/lib/update-store.ts` elides `percent` from the render snapshot so React never re-renders on it ([L06]); `ProgressDetail` in `update-tug-rows.tsx` subscribes directly and writes `42% downloaded` into a span. Extraction reports 0…1 and is shown as the sentence "Verifying the signature…". The pill draws no progress at all. **(verified)**

**[F07] The gallery already has the bar.** `tugdeck/src/components/tugways/tug-progress-indicator.tsx`, `variant="bar"`: determinate with `value`/`max`, runs its barber pole while `value` is undefined or zero (a fresh bar never sits at a literal 0%), freezes on `state="paused"` with `caution` as the default role, paints `aborted` in danger, `completed` full, and has a width-stabilized `showValue` readout. The internal `tug-progress-bar.tsx` draws the fill as an inline width from the `value` prop and suppresses the backward transition. `TugStepRow` has a `body` slot documented as "a control rather than prose," and its docblock says a host scopes row height per row where a step carries a control. **(verified)**

**[F08] Both Claude Code rows run the official script blind.** `install_claude` and `update_claude` in `tugrust/crates/tugcast/src/actions.rs` call `claude_auth::install()`, which is `bash -c "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"` and returns `(ok, last stderr line)`. The deck's `authStore.installing` is a boolean. Read on 2026-09-25, the script fetches `$DOWNLOAD_BASE_URL/latest`, then `$version/manifest.json` whose `platforms[<platform>]` carries `size` and a SHA-256 `checksum`, then the binary (a `.zst` when `zstd` is present, else raw) with a silent `curl -fsSL -o`, verifies the checksum, `chmod +x`, runs `"$binary_path" install`, and deletes the download. The pieces a determinate bar needs — a byte total and a checksum — are in the manifest. **(verified)**

**[F09] The Command Line Tools row is Apple's transfer.** `offer_host_tools` runs `xcode-select --install`, which returns as soon as Apple's panel is up; `host_tools::await_command_line_tools` then watches `/Library/Developer/CommandLineTools` with `notify` under a horizon. Tug sees no bytes and owns no process. **(verified)**

**[F10] Sparkle 2.9.4 cannot pause a download.** In the resolved package (`SourcePackages/checkouts/Sparkle`, `git describe` → `2.9.4`), `Downloader/SPUDownloader.m` uses `downloadTaskWithRequest:` and `_cleanup` calls `[_sessionTask cancel]` — never `cancelByProducingResumeData:` — and removes the persistent download directory. The cancel closure `SPUUIBasedUpdateDriver` hands `showDownloadInitiated(cancellation:)` calls `uiDriverIsRequestingAbortUpdateWithError:nil`, which ends the whole session; `SPUUpdater` keeps a resumable update only once a download has *completed* (`SPUDownloadedUpdate`). So "cancel" is "discard the bytes and forget the update was found." **(verified)**

**[F11] Sparkle will accept a local file as the enclosure, on paper.** `SPUUpdaterDelegate` offers `updater(_:willDownloadUpdate:withRequest:)` with a mutable request. `SPUValidateStatusCodeAndFailIfInvalid` in `SPUDownloader.m` treats a non-`NSHTTPURLResponse` as status 200, and `NSURLSession` download tasks handle `file:` URLs. EdDSA verification runs on the downloaded file regardless of origin, so a rewrite changes nothing about trust. `UpdateController.swift` already implements the delegate (`feedURLString`, `didFinishUpdateCycleFor`), so the hook is one method away. **Not yet exercised** — see [B10]. **(inferred from source)**

**[F12] The wizard's Close is already pause at the wizard level.** [B04] of the update-tug brief: Close posts nothing, and a download keeps running behind a closed panel. That is the "don't block the user" half; what is missing is stopping the transfer without losing it. **(verified)**

**[F13] The stall horizon is keyed to percent.** `useStalled` in `update-tug.tsx` re-arms `WAIT_DEADLINE_MS.downloading` on every percent change. A paused download would trip it after two minutes and turn the row red with Retry. **(verified)**

**[F14] A rehearsal path exists.** `just update-rehearse` serves a local appcast (`tests/update/local-appcast.sh`); `tests/update/test-update-state.sh` runs `UpdateState.swift` through `swift -` against `test-driver.swift`, Foundation-only. Neither can throttle a download today. **(verified)**

---

## Decisions {#decisions}

**[B01] One deck fact, `appModalOpen`, and it freezes the card count.** A small store in `tugdeck/src/lib/` (`app-modal-store.ts`) that the three app-modals — `ConfigureTug`, `UpdateTug`, `TugVersionGate` — write from a layout effect on their own open state ([L03]; for `ConfigureTug` the write is a side effect of the derivation in [F05], not a second source of truth). The menu-state aggregator in `host-menu-state.ts` subscribes to it the way it subscribes to the keymap registry. Nothing else reads it; the store is a publication seam, not a new state zone.

**[B02] The fact rides the wire twice, because enablement has two tiers ([F02]).** Mirrored commands get it folded into their published gate: a registry flag on the entry — `changesCardCount: true` — that ANDs `!appModalOpen` into `validate` for Close, Close All Tabs, New Text File, Open File, Open Quickly, and Open Recent ▸ Clear Menu, and the projection in `computeCommandCapabilities` honours the flag. Host-owned items get a top-level `menuState.appModalOpen: boolean` that `validateMenuItem` consults for `file.newSessionCard`, `file.newJot`, `app.about`, `app.settings`, `app.keyboardShortcuts`, and the Open Recent entries built in `menuNeedsUpdate`. The Swift `MenuState` struct and the TypeScript payload change in the same round, per the contract's own rule. No chord is detached ([F03]): the beep is the answer.

**[B03] Settings and Keyboard Shortcuts are gated alongside About.** The user named About and the File menu; the rule that names them is "anything that changes the card count," and those two open cards too. One rule with no exceptions is easier to keep than a list. The Window menu's pane list and the Session menu move focus, not count, and stay live.

**[B04] The wizards gate each other's doors, and the version gate keeps precedence.** Tug ▸ Configure Tug… and the `configure-tug` action are dark while `UpdateTug` is open; the update pill's click and Tug ▸ Check for Updates… raise nothing while `ConfigureTug` is open (the request is dropped, not queued — the pill stays lit and the menu item stays enabled, so the door is still there when the setup wizard closes). `TugVersionGate` outranks both as it does today. The wizard's own "Start a session" step remains the one card-creating act allowed under a modal, because it is the wizard.

**[B05] Every row that transfers bytes gets a `TugProgressIndicator variant="bar"` in `TugStepRow`'s `body` slot.** Determinate wherever a total is known — Sparkle's download and extraction, the Claude Code binary — and the barber pole falls out for free wherever it is not, because the bar runs indeterminate while `value` is undefined ([F07]): Check for updates, Verify signature, Install and relaunch, and the Command Line Tools row while Apple's installer runs. The readout rides the bar's own `showValue`. States map to the indicator's own: `running` while bytes move, `paused` when the user paused, `aborted` on error, `completed` at the end. The bar replaces the `42% downloaded` span; nothing else on the row moves.

**[B06] The detail line says bytes, rate and time, not just a percent.** `12.4 MB of 48.1 MB · 1.2 MB/s · about 30 s left` while running; `Paused at 12.4 MB of 48.1 MB` when paused; `Starting…` until a total is known (never a false 0). The host snapshot gains `receivedBytes` and `expectedBytes` beside `percent`; the publish rule stays "on a whole-percent change" ([F06]), so wire traffic does not grow and the bytes ride the publishes that already happen. Rate and ETA are computed on the deck from successive (bytes, monotonic time) pairs with an exponentially weighted average, and are never React state. The same fields cross for the Claude download on its `claude_install_progress` control frame ([B08]).

**[B07] Progress stays out of React, and the bar grows one imperative seam to make that true.** The internal bar draws its fill from a prop today ([F07]); it learns to honour a `--tugx-progress-indicator-value` custom property on its own element when one is set, and `TugProgressIndicator` exposes the element through a ref. The painter that already writes the detail span writes the property, `aria-valuenow`, and the readout text from a direct store subscription, exactly as `ProgressDetail` does now. A leaf component with its own `useSyncExternalStore` selector on `percent` was considered and rejected: it is a hundred renders per download by construction, and the store's docblock says drawing progress is a CSS custom property's job.

**[B08] tugcast owns the Claude Code download, and the official script becomes the fallback.** A `claude_download` module in `tugrust/crates/tugcast/src/feeds/` reproduces exactly the script's fetch sequence ([F08]) — `latest`, `manifest.json`, the platform's `size` and `checksum` — then streams the binary with `reqwest` to a partial file under Tug's own cache directory (`~/Library/Application Support/Tug/downloads/claude-<version>-<platform>.partial`), publishing `claude_install_progress { received, expected, version }` on whole-percent changes, verifies the SHA-256, `chmod +x`, and runs the binary's own `install` subcommand — which is what the script does too, so shell integration, launcher and `$TARGET` handling stay Anthropic's. If `latest` or the manifest cannot be fetched or parsed, the existing `curl | bash` runs unchanged and the row shows the barber pole. Update Claude Code is the same path with different reporting. The `.zst` variant is skipped: it saves bandwidth only where `zstd` is installed and adds a second checksum and a decompression step to a path whose whole point is a bar the user can trust.

**[B09] Pause and resume are two control frames and a partial file on disk.** `claude_download_pause` drops the in-flight request and keeps the partial file and the version it was fetched for; `claude_download_resume` re-reads `latest`, and if it still names the same version, continues with a `Range: bytes=<len>-` request (falling back to a restart on a 200 rather than a 206), otherwise starts over and says so in the detail line. Because the partial and its version are on disk, a pause survives a tugcast restart and an app relaunch. `authStore` grows `paused: boolean` and the byte pair, and the row's trailing slot becomes **Pause** while running and **Resume** with a ghost **Cancel** beside it while paused — the primary-plus-ghost shape the polish brief's [B05] established. Cancel deletes the partial.

**[B10] `UpdateTug` gets pause and resume by the host owning the enclosure download, gated on one spike.** The host downloads the appcast enclosure itself with `URLSession` — `cancelByProducingResumeData` to pause, `downloadTask(withResumeData:)` to resume — under `~/Library/Application Support/Tug/updates/<build>/`, persists the resume data beside it so a pause survives quitting Tug, and reports bytes through the same reducer. When the archive is complete the host answers Sparkle's `install` and, in `updater(_:willDownloadUpdate:withRequest:)`, rewrites the request URL to the local file ([F11]); Sparkle "downloads" it at disk speed, verifies the EdDSA signature, and extracts as today, so the row flips from Tug's bar to Sparkle's verify phase with nothing else changing. **The spike comes first**: against `just update-rehearse`, prove a `file:` rewrite reaches `readyToInstall` on a Release-configuration bundle, and check both downloader modes (in-process, and the XPC downloader service if `SUEnableDownloaderService` is ever set). If the spike fails, the fallback is decided now rather than later: a **Stop for now** button that cancels Sparkle's download with the cost said out loud — "Stopping discards 12.4 MB; the download starts over when you resume" — and the word *pause* appears nowhere on the surface. Either way the trust story is unchanged: Sparkle verifies the archive, and Tug never installs anything it did not verify.

**[B11] The archive's lifetime is bounded.** Under `[B10]`, the partial or complete archive and its resume data are deleted on a successful install, on Skip, on Cancel, and when a newer build is found (supersession) — the check that finds `0.9.2` deletes `0.9.1`'s directory. A directory with no owner in the current appcast is swept at launch. Nothing under `updates/` is ever installed without Sparkle's signature check.

**[B12] A paused transfer has no horizon.** `useStalled` disarms entirely while the stage is `paused` ([F13]), and re-arms on bytes rather than on percent while downloading so a slow link that moves 100 KB in two minutes is still "moving." The user's own pause is not a wait, and [L33] asks for a horizon only on waits.

**[B13] The wire and the reducer grow a stage and two actions.** `UpdateStage` gains `paused`; `UpdateAction` gains `pause` and `resume`; `TugStepRowStatus` gains `paused`, mapped to the dot's `{ role: "caution", state: "paused" }` — the indicator's own default for a held thing. `tests/update/test-update-state.sh` covers the new transitions, including that `paused` keeps `version`, `build` and the byte pair, and that a `resume` re-enters `downloading` without resetting them. The pill keeps its one sentence ([B02] of the update-tug brief): a paused download is the wizard's to show.

**[B14] The rehearsal can be throttled, and the app-tests press the buttons.** `tests/update/local-appcast.sh` gains a rate option (kilobytes per second) so a download can be watched, paused mid-transfer and resumed by hand; `at0612` is extended to pin the bar's `aria-valuenow` moving and the Pause → paused row → Resume → downloading round trip through the bridge fixture; a new app-test with `@covers` for `host-menu-state.ts` and `AppDelegate.swift`'s validator pins that `menuItemState("file.newSessionCard")` and `menuItemState("app.about")` read disabled while `UpdateTug` is open and enabled after Close. The Claude path gets a Rust test against a local HTTP server that serves a manifest and a binary in chunks, asserting the partial file, the `Range` resume, the checksum failure path, and the fallback to the script.

**[B15] The Command Line Tools row gets a bar and no pause.** The barber pole runs while the watch is armed, the detail reads "Installing in Apple's window — about 3 GB," and the trailing slot keeps Recheck. Tug owns neither the bytes nor the process ([F09]), and a Pause button that could not pause would be the dead button [B09] of the update-tug brief spent a whole round removing.

---

## Open Questions {#open-questions}

None that would change what gets written. The one genuine unknown — whether Sparkle accepts the `file:` rewrite end to end — is not a question but a spike, and [B10] names both outcomes so the arc does not stall on it.

---

## Non-goals {#non-goals}

- **Hiding menu items instead of dimming them.** Stable menu bars preserve discoverability (`tuglaws/menus.md`); the Session menu is disabled, not hidden, for the same reason.
- **Detaching the card-count chords so they fall through to the web view.** Nothing behind the modal should answer ⌘N; the beep is the correct feedback ([F03]).
- **Byte-level pause through Sparkle.** Sparkle 2.9.4 has no such thing ([F10]); asking it to pause is asking it to discard. Patching Sparkle is out — Tug tracks the upstream package.
- **Serving the archive to Sparkle over a loopback HTTP server.** Considered as an alternative to the `file:` rewrite; it adds a listener, a port and a lifetime to manage for something a file URL does with none of them. Revisit only if the spike in [B10] fails for a reason a loopback would cure.
- **Progress or narration on the pill.** [B02] of the update-tug brief holds: one sentence, "an update exists." The wizard is the place that shows what the flow is doing.
- **Reproducing the whole official installer in Rust.** [B08] copies the fetch sequence and hands the rest to the binary's own `install` subcommand. Shell integration, launcher placement, `$TARGET` and sudo handling stay Anthropic's, and the script stays as the fallback.
- **Extraction, signature verification or install progress beyond what Sparkle reports.** Extraction is determinate today; verification and install are indeterminate and short, and stay barber poles.
- **Resuming a paused Claude download across a `latest` that moved.** A new version restarts the transfer and says so; stitching two versions' bytes is not a thing.
- **A Pause on the Command Line Tools row** ([B15]).
- **A React-state path for progress** ([B07]).

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. The `appModalOpen` store, the three writers, the aggregator subscription, the registry flag, and the `menuState` field with its Swift parse — the whole of [B01]–[B04] — with the menu-state app-test from [B14]. This step touches nothing about downloads and can land alone.
2. The bar in the row: the internal bar's custom-property seam and ref ([B07]), the byte pair on the host snapshot and the deck store ([B06]), the rate/ETA painter, and `at0612` extended to read `aria-valuenow`. Still no pause anywhere; the download row shows a real bar with Cancel on it.
3. The Sparkle `file:` spike from [B10], against a throttled `just update-rehearse` ([B14]). Its outcome picks the shape of step 4 and is written into the arc log either way.
4. `UpdateTug` pause/resume: the host-owned download, resume data, the archive directory and its lifetime ([B10]–[B13]) — or the Stop-for-now fallback with its copy, if the spike said so.
5. The Claude Code download in tugcast with its partial file, `Range` resume, control frames, fallback and Rust tests ([B08], [B09]); the deck's `authStore` fields and the row's Pause/Resume/Cancel cluster; the Command Line Tools row's bar ([B15]).
6. Release notes for the version that ships it, and `tuglaws/design-decisions.md` entries for the app-modal gate and the host-owned downloads.

Steps 4 and 5 are independent of each other and both depend on 2. Step 1 depends on nothing.
