# Claude Code Version Handling Across ConfigureTug and UpdateTug

**Purpose:** Updating Tug can raise the Claude Code version Tug requires, and today the user learns that only after the new Tug is installed, from a wizard they cannot decline. This brief records how the two wizards handle the Claude Code version now, and what they should do instead.

---

## Purpose {#purpose}

The user asked:

> How does the ConfigureTug and UpdateTug process work when the supported version of Claude Code in the app change? When you download an app update, how do we handle updating the user's machine to the lastest Claude Code? Can the user refuse this? What if they do? Do we just go on letting them use an older version if we support it? Does that work? I need clarification of what happens and what should happen.

The answers today are: the app update does nothing about Claude Code; a user below the floor cannot refuse; a user above it is never asked; and "does that work" rests on one hand-set constant that nothing tests.

---

## Evidence {#evidence}

**[F01] UpdateTug knows nothing about Claude Code** — neither `tugdeck/src/components/tugways/update-tug.tsx`, `update-tug-rows.tsx` nor `tugapp/Sources/UpdateState.swift` contains the word. An app update neither checks nor changes the installed Claude Code. **(verified, by grep)**

**[F02] One constant links an app version to a Claude Code version** — `MIN_CLAUDE_CODE_VERSION = "2.1.285"` in `tugdeck/src/components/tugways/configure-tug-copy.ts`. It was set in `f7a0d50e7`, when 2.1.285 changed the model row shape. Nothing derives it and no test ties it to a capture. **(verified)**

**[F03] Below the floor, ConfigureTug claims the app with no way out** — `claudeTooOld` is a term of `deriveConfigureTugRequired`. The install row reads "Requires Claude Code X or later. This Mac has Y — update to continue." with an Update button; the rows after it hold. There is no skip. The user updates or quits. **(verified, read from the code; `at0440` covers the row)**

**[F04] That claim is not relaxed offline** — the doc comment on `claudeTooOld` says so deliberately: "Not relaxed by the path hint." The same function does relax the claim for a definite `logged_out` over an `unsatisfied` path, so that a user who cannot reach the fix is not held out of the app. An offline user below the floor is held with a button that cannot work. **(verified)**

**[F05] At or above the floor, nothing is asked** — the install row offers an optional Update when the installed version is older than the channel's, and the row is seen only when the wizard is open, which on a set-up app means the Tug-menu Configure Tug… item. Nothing else surfaces the offer. **(verified)**

**[F06] There is no ceiling** — no code compares the installed version against an upper bound. A newer `major.minor` line than the validated one paints a `version_drift` caution badge on blocks (`session-assistant-renderer-dispatch.ts`); a newer patch paints nothing. **(verified)**

**[F07] The row and the button read different channels** — the row's "X is available" comes from `STABLE_CHANNEL_URL` (`…/claude-code-releases/stable`) in `tugrust/crates/tugcast/src/feeds/claude_auth.rs`. The download behind Update resolves `{base}/latest` in `resolve_release`, `tugrust/crates/tugcast/src/feeds/claude_download.rs`. A press can install a version newer than the one the row named, and an install sitting between the two reads as up to date. The comment on `A::UpdateClaude` in `actions.rs` says the installer lands "the stable channel's newest build", which the code does not do. **(verified)**

**[F08] Update installs the channel's newest, never a version Tug was captured against** — `run_claude_install` takes no version argument. A forced update can therefore land a Claude Code newer than `capabilities/LATEST`. **(verified)**

**[F09] Three version constants have drifted apart** — the floor is 2.1.285, `capabilities/LATEST` is 2.1.325, and `VALIDATED_CC_VERSION` in `session-assistant-renderer-dispatch.ts` is 2.1.147. The last is harmless today only because drift is judged on `major.minor`. **(verified)**

**[F10] The versions between the floor and the snapshot are untested** — the app bundles the 2.1.325 capability snapshot and the test suites pin that capture. Nothing runs against 2.1.285 through 2.1.324. That the floor is honest is a belief, not a measurement.

**[F11] Tug does not touch Claude Code's own auto-updater** — no source sets `DISABLE_AUTOUPDATER` or an equivalent. **(verified, by grep)** Whether the auto-updater runs under tugcode's spawns was not checked. If it does, most users sit ahead of the tested version, which is the direction [F06] leaves unguarded.

**[F12] A Claude Code update reaches the next spawn, not a running one** — tugcode resolves the `claude` path and version once per spawn (`tugcode/src/spawn-config.ts`). **(verified)**

---

## Decisions {#decisions}

**[B01] UpdateTug states the incoming Tug's Claude Code floor before Install, and carries the Claude Code update as a step of its own.** When the incoming floor is above the installed version, the wizard says so — "This update needs Claude Code X; you have Y" — and the Claude Code update is a row the user presses before the install row. The point is where the refusal lands: declining then leaves the old, working Tug in place, which today's order ([F01], [F03]) makes impossible. The row sits before Install rather than after because an older Tug with a newer Claude Code is already a permitted state ([B04]), so a wizard closed between the two rows leaves nothing broken.

**[B02] The floor rides the appcast.** The running Tug has to know the incoming version's floor before it installs it, and the only thing it has read about the incoming version at that point is the appcast item. This ties the floor to the release, which is also where [B07] records it.

**[B03] ConfigureTug's post-relaunch gate stays, as the backstop.** [B01] cannot cover a Tug replaced by hand, a Claude Code downgraded afterwards, or an update taken by a path other than the wizard. The gate in [F03] already answers those and is kept as it is, except for [B05].

**[B04] Between the floor and the tested version, the user is left alone.** At or above the floor Tug runs, the Update row stays optional, and nothing nags. Above the tested version there is still no ceiling. The floor is raised only when Tug starts depending on something a newer Claude Code introduced, because every raise is a forced update for somebody. Revisit if [F10] turns out false in practice — a report of breakage inside the supported range is the signal to raise the floor, not to add a nag.

**[B05] An offline user below the floor is not held out of the app.** The `claudeTooOld` claim is relaxed on an `unsatisfied` path the same way the logged-out claim already is ([F04]), read in the negative direction only. They can launch and read what is on disk; a turn is refused with the reason shown. This is a don't-block relaxation and nothing more: the user's point is that Tug does little offline and no AI work happens there, so no offline feature is being built — the app simply stops presenting a door with no handle.

**[B06] One channel: the row compares against what the button installs, and that is `latest`.** `latest` is what the download already resolves and what the captures are taken against, so the row's lookup moves to it and the stale comment in `actions.rs` is corrected ([F07]). Pinning Update to the exact tested version was considered and is in Non-goals.

**[B07] One source for the numbers.** The validated version is derived from `capabilities/LATEST` at build time rather than hand-kept ([F09]). The floor stays a hand decision, because only a person knows what Tug started depending on, but it becomes a line on the release checklist and is stated in that version's release notes whenever it moves.

---

## Open Questions {#open-questions}

- **How the floor is carried in the appcast and read by the host.** Whether it is a custom element on the appcast item, and how `UpdateState.swift` gets it into the update snapshot the deck reads, depends on what the Sparkle integration and the appcast generation in `version.sh` expose. It is settled by reading those two; it changes the mechanism of [B02], not the decision.
- **Whether Claude Code's auto-updater runs under tugcode's spawns ([F11]).** Settled by watching the installed version across a few days of Tug-only use, or by reading Claude Code's documentation for headless runs. If it does run, most users are already ahead of the floor and [B01]'s row will rarely appear; nothing here changes either way.

---

## Non-goals {#non-goals}

- **A ceiling on the Claude Code version.** Refusing a version newer than the tested one would lock out every user whose Claude Code updated itself, to guard against breakage the drift badge already flags.
- **Pinning Update to the tested version.** The downloader could fetch an exact version, but Claude Code may move itself forward afterwards ([F11]), so the pin would hold only until the next self-update and would cost a second notion of "current".
- **A nag for users between the floor and the newest release.** If the version works, a prompt to change it is noise; if it does not, the floor is wrong and should be raised.
- **Disabling Claude Code's auto-updater.** It is the user's install, shared with their terminal use; Tug does not reconfigure it.
- **Testing every version between the floor and the snapshot.** The floor is kept honest by raising it on evidence ([B04]), not by a matrix.
- **An offline mode.** [B05] removes a block; it adds no capability.

---

## Exit {#exit}

**An arc.** The pieces are largely independent, and a workable order is:

1. The small corrections that stand alone: the row reads `latest` and the `actions.rs` comment is fixed ([B06]); the validated version is derived from `capabilities/LATEST` ([B07]).
2. The offline relaxation in `deriveConfigureTugRequired`, with its copy and unit cases ([B05]).
3. The floor in the appcast and through the host's update snapshot ([B02]), after the first open question is read out of the code.
4. The UpdateTug statement and the Claude Code row before Install ([B01]), which depends on step 3.
5. The release checklist and release-notes line for the floor ([B07]).
