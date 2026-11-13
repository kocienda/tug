# Workspace Stages: Finish the Rail and the Cold Arrival

**Purpose:** After `workspace-stages` landed (`369d83290`), a workspace switch is fast and live, but two things still read wrong on the user's deck: the shared rail clears at a switch between workspaces of different themes, and a cold arrival at a workspace flashes, both in its app-modal alert and in its cards.

---

## Purpose {#purpose}

The user's report, after rebuilding and relaunching on `369d83290`:

> This is great progress. The liveness and speed seem greatly improved. There are still two areas that need further improvement.
> - Switch workspaces *clear* the sidebar rails. Ummm.... I thought we made them shared! They must not clear like this.
> - After relaunch, a cold load of a workspace *flashes too much*. The app-modal dialog seems like it can flash. Cards too, which they shouldn't, since we have skeletons.

Two constraints the user set while the fix was being shaped:

- The rail must never clear, and it must never wear the departing theme's colours beside the arriving deck. Both a skeleton over the rail and a rail whose skin trails the cut were rejected outright.
- The app-modal alert stays. In the user's words it is "the *user-perceptible cover* for the time between the workspace becoming visible and it being fully usable", and that story-telling must be preserved.

---

## Evidence {#evidence}

**[F01] The rail clears by design at every cross-theme cut.** `cut(to:door:)` in `tugapp/Sources/BodyViewController.swift` (the block that fills `railReskin`, near line 1208) stands a title-only skeleton over each shown rail card when the arriving stage's theme differs from the departing one, tells the page the theme (`bodyTheme`), and takes the skeleton down on the page's `painted` carrying that theme (`didPaint`, near line 839). The rail pages themselves never move or reload. This is the `workspace-stages` brief's open question, answered by the user: it reads as the rail clearing. **(verified, read from the code; matches the user's screenshot of title-only rail cards mid-switch)**

**[F02] The rail's re-skin time on the user's deck is not known.** The 60–80 ms figure in the `workspace-stages` record came from `tests/app-test/readings/at0816-rail-reskin-reading.test.ts`, whose rail holds plain text cards, and it includes the two `requestAnimationFrame`s the page waits after applying the theme before it says `painted` (`tugdeck/src/body/body-main.ts`, the `bodyThemeToPage` handler). The host logs no re-skin time, and the user's rail holds Arcs, Jots, Overview, Workspaces and Layout, of which Overview is a long feed. The live log has no `rail re-skin past its horizon` line, so every re-skin finished inside 2 s; nothing finer is on record. **(verified that it is unmeasured)**

**[F03] The app-modal that flashes is the "Restoring sessions" gate, and it drops between staggered pages.** `tugdeck/src/lib/restore-gate-store.ts` opens the gate while any card holds it, and a body card holds only when its body says `"holding"`, has a page (`!pageless(...)`), is not dormant, and is in the shown workspace. A cold workspace's pages are made one after another: the live log for the cut at `2026-11-13T21:27:50Z` (`live=0 last_frame=2 skeleton=8`) shows `page loaded` lines spread across 2.7 s, roughly one every 300–500 ms. So the gate opens for one card, closes when it settles, and opens again for the next. The store's own header says a round "outlives a gate that closes between staged pages". **(the rule is verified from the code and the stagger from the log; the open-close-open on screen is inferred, and a harness row sampling the gate across a cold arrival would confirm it)**

**[F04] A resumed card's skeleton comes down before its transcript is on screen.** `signalReadyWhenQuiet` in `tugdeck/src/body/body-main.ts` calls the page quiet once its session is out of `restoring` and `replaying`, and posts `painted { content: true }` two frames later; the host takes the skeleton down on that. The reveal comes after: `tugdeck/src/lib/session-card-restore-gate.ts` describes the stretch from `replay_complete` to the transcript list's first settle as 0.3–3 s on the release deck, "where the main thread is busiest and the card still shows nothing". `deriveRestoreGateHold` already spans replay plus reveal, bounded by `COLD_REVEAL_SETTLE_BOUND_MS` (10 s), and the gate uses it; the skeleton does not. So the card goes skeleton, then empty or hopping, then transcript. **(verified, read from the code)**

**[F05] After a relaunch the host knows one theme's palette.** `ThemePalettes` in `tugapp/Sources/BodyStages.swift` learns a palette from the shell's `setTheme` (the on-screen theme) and from each body page's `bodySurface` (that page's theme), keeps them in memory only, and falls back to the on-screen palette for a theme it has not heard. The live log at `2026-11-13T21:24:51Z` has `stage palette missing` for `collier`, `sloop`, `barque` and `caravel`. A workspace with no page made ahead therefore has its ground and its skeletons drawn in the departing theme's colours at the cut, and they flip when its first page reports. The cut onto `45e63e0b…` at `21:34:04Z` (`last_frame=0 skeleton=3`) is one with no page to have reported. **(the missing palettes and the fallback are verified; that this cut drew in the wrong colours is inferred from them)**

**[F06] The gate's original premise no longer holds, and the user keeps the gate anyway.** The gate was written when every card shared one thread and a cold restore froze the whole app (`tugdeck/src/components/chrome/restore-gate.tsx`, "Why an app-modal"). Each card now has its own page, so one card's restore blocks only that card. The gate's remaining job is the one the user named: telling the user the workspace is visible but not yet fully usable. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] The rail never stands a skeleton and never shows the departing theme beside the arriving deck.** Both were tried on the user, one on screen and one as a proposal, and both were refused. The `railReskin` skeleton path is removed.

**[B02] At a cross-theme switch the rail re-skins first, and the cut lands with it.** At the gesture the host tells each shown rail page the arriving theme and changes nothing on screen. Each rail page flips its theme (its stylesheet is already preloaded by `preloadTheme`) and answers from the frame callback just before its paint, without the two-frame padding the current `painted` carries. When every shown rail page has answered, the host makes the cut as it does now: one transaction, the same doors and serials. A page in another process cannot repaint inside the host's transaction, so ordering the rail ahead of the cut is the only way its own live content can be in the arriving theme in the frame the deck changes. The cost is that a cross-theme cut lands a few frames after the gesture; a same-theme cut is untouched. The page's paint and the host's cut are two processes' commits and can land one frame apart, which is the floor without a snapshot, and no snapshot goes on this path.

**[B03] The rail's wait has a horizon, set from a measurement on the user's deck.** The host logs each rail page's time from the theme being told to its answer. That line is read on the user's deck before the bound is fixed. Past the bound the cut goes anyway, the slow rail card finishes its re-skin after it, and the host logs a warning naming the card.

**[B04] The restore gate stays, and opens once and closes once for each cold arrival.** Every resumed Session card in the shown workspace that has not yet settled holds the gate, including a card whose page has not been made yet. The gate opens at the cut onto a workspace with at least one such card, and at launch for the restored workspace. It closes once, when the last of them settles or reaches its existing horizon. A workspace whose cards are all live or settled raises nothing. The rules that keep a hidden workspace or a sleeping page from holding the gate (shown workspace only, the 20 s hold horizon, the 2 s watch) stay as they are.

**[B05] Once open, the gate stays on screen at least 1.25 s.** The user's call: a gate that opens and closes inside a few hundred milliseconds is itself a flash, and holding it "for a total of 1.25s" beats the flash at the cost of a small delay while keeping the story. The floor is counted from the moment the gate opened, so the gate closes at the later of the last card settling and 1.25 s after it opened; a long arrival gains no delay. During the held time the count and the bar show the finished state, so the hold reads as done and not as stuck. The app stays modal until the gate closes.

**[B06] A resumed card's skeleton stands until its transcript has settled.** A resumed Session page's readiness becomes "out of `deriveRestoreGateHold`" in place of "out of restoring and replaying", so its `painted { content: true }` follows the reveal and the skeleton comes down onto a settled transcript. The reveal's 10 s bound and the picture's 2 s horizon over a painted page remain the ways out. With [B04] this makes one story: under the gate each card goes from skeleton to settled transcript, and the gate closes as the last skeleton does.

**[B07] The host keeps each theme's palette across launches.** A palette is persisted as it is learned, keyed by the app's build so a theme edited between builds is not drawn from an old palette, and loaded at launch. Every stage's ground and skeletons are then in their own theme at the first cut, and `stage palette missing` is a first-run line only.

---

## Open Questions {#open-questions}

- **Is the rail's re-skin on the user's deck short enough to wait for?** [B02] rests on the answer being a few frames. If the measurement in [B03] shows a rail card (Overview is the likely one) taking on the order of 100 ms or more to answer, the wait is too long to hide and [B02] does not hold as written. The alternative then is a design change the user would have to make: the rail wears one window theme and never re-skins. Settled by the log line of [B03] read on the user's deck, which is the arc's first act.

---

## Non-goals {#non-goals}

- **A skeleton over the rail at a cut.** What landed in `workspace-stages`; the user reads it as the rail clearing.
- **A rail whose skin trails the cut.** Keeping the rail's live pages up in the departing theme until they repaint was proposed and refused: the rail would wear the wrong colours beside the new deck for those frames.
- **Retiring the restore gate.** Proposed on the grounds of [F06] and refused: the gate is the user-perceptible cover for "visible but not yet usable".
- **A snapshot of the rail on the switch path.** It would make the cut exactly atomic, and it puts tens of milliseconds of capture between the gesture and the cut, which `workspace-stages` removed from every waiting path.
- **A second set of rail pages per theme.** Atomic and live, but it multiplies the rail's web views by the number of themes in use and splits each rail card's state (a filter, a scroll position, the Overview composer's text) across twins.
- **A last frame of each rail card kept per theme.** It shows stale content at the cut, such as the wrong active row in Workspaces.
- **A threshold under which a short arrival raises no gate.** A rule that sometimes skips the gate is harder to read than a gate that always tells the arrival; [B05] answers the short case instead.

---

## Exit {#exit}

**An arc.** The first act is the measurement, since the open question turns on it: add the host's log line for a rail page's theme answer and read it on the user's deck. Then, in an order where each piece can be judged alone:

- The host keeps palettes across launches ([B07]). Host-only, independent of the rest.
- The rail goes first ([B01]–[B03]): the page's early answer, the host's hold of a cross-theme cut until the rail has answered, the horizon, and the removal of `railReskin`. `at0816` changes from a timing reading to an assertion that across a cross-theme cut no rail card shows a skeleton or a theme other than the shown stage's in any sampled frame.
- The skeleton stands through the reveal ([B06]), in the body page.
- The gate's hold rule and its 1.25 s floor ([B04], [B05]), in the shell, landing with or after [B06] so the gate and the skeletons close together. A cold-arrival row asserts that the gate opens once and closes once, stays up at least 1.25 s, and that no resumed card shows live before its transcript settles.
