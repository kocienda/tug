<!-- brief-skeleton v1 -->

# Workspace switch and create: a parked workspace is a finished picture

**Purpose:** Switching between workspaces and creating a new one are still flashy. The switch is already one cut and the create already lands on faces, and both judges are green; what still flashes is everything that redraws a card *after* the cut, each card on its own clock.

---

## Purpose {#purpose}

The user's report, 2026-11-03: "Switching between workspaces and creating new workspaces *is still far too flashy*. This is an essential feature, and it has not yet reached the level of polish I require. Banish the flashing!"

The earlier rounds (`briefs/switch-hand-over-brief.md`, `briefs/workspace-create-flash-brief.md`) made the switch a single host transaction and the create a cut onto faces, and `body-grounding/row-44-*` and `row-10-*-dormant` hold those. Their bars are "no hole, no card in the wrong place". They say nothing about a card that is in the right place and then changes its colour, blanks its content, or pops in beside a neighbour that popped a frame earlier. That cascade is what is left, and it is what this brief is about.

---

## Evidence {#evidence}

**[F01] Every switch on the user's deck is a theme change, and body pages re-tint after the cut.** The user's four workspaces wear four themes: Main ironclad, tug-site barque, eucit collier, writing caravel (read from a copy of the release instance's `tugbank.db` layout). The shell flips its own sheet inside the swap commit (`activateSpace`, `tugdeck/src/deck-manager.ts`, `applyLoadedTheme`). A body page learns the theme as a deck-wide fact, `theme: getOnScreenTheme()` in `readDeckFacts` (`tugdeck/src/lib/body-shell.ts:455`), republished over the bus on every on-screen flip (`subscribeOnScreenTheme(publishDeckFacts)`, line 1181), and applies it asynchronously in `applyDeckFacts` (`tugdeck/src/body/body-main.ts:448`, `applyTheme(...).then(postSurface)`). A parked body hears every flip, so at the cut it wears the *departed* workspace's tint, and re-tints one to three frames later, each card on its own bus delivery. No judge reads hue. The create is immune: `createSpace` gives the new workspace the theme of the one being left. **(verified, read from the code and the layout; the frames were not recorded)**

**[F02] A return to a dormant workspace blanks every session card's content, then refills it.** The host declares a hidden body dormant after five minutes (`BodyLifecycle.dormantAfter`), and the release log shows the user's switches land on dormant cards nearly every time (six to nine `dormant=yes`/`dormant=no` lines per switch through 2026-11-01 and 2026-11-03). At sleep `installBodyDormancy` lids the content box (`data-body-dormant`, `tugdeck/src/body/body-dormancy.ts`; the rule in `body-page.css:60`), and the lid stays until the catch-up bracket closes. Tonight's brackets closed 3 to 55 ms after the ask on the server (`merger.replay_bracket_open/close` at 23:19:14 and 23:19:43 in `tugcast.log`), which the page sees as a few frames, per card. The card's DOM is intact under the lid throughout. A card with no session wakes synchronously inside the reveal and never shows its lid. **(verified: code and log; the on-screen duration is inferred from the bracket times plus the page's frames)**

**[F03] The lid's justification was the mid-turn case.** `briefs/body-lifecycle-program-brief.md`, open questions: "A body that slept mid-turn stood 4–6 display periods between being shown and its catch-up landing, more than a frame, so it wears the content lid from sleep to wake." The reading was of a card whose content changed after the reveal. For a card that slept idle, which is the ordinary one, the lid trades nothing against a blank-then-content frame sequence. **(verified, read)**

**[F04] A first visit after launch, and a create, pop their cards in over about 1.5 s.** Tonight's log at 23:23:33: a hand-over with eight faces (`snapshot_ms=184`), then the pages made two at a time through the lane (`BodyLane.width = 2`), painting at +0, +0.32, +0.40, +0.79, +0.79, +1.20, +1.28 and +1.45 s. Each page shows twice: its chrome at `painted` and its content when `card.painted` lifts the content lid (`CONTENT_PAINTED_ATTRIBUTE`, `tugdeck/src/body/body-chrome-frame.tsx`). The user quit and relaunched the app at 23:19:53 and 23:21:33 the same evening, as on most days, so this is every workspace's first switch every day. The create is the same shape with five rail cards (`row-44-switch-create` reads 1.6 s for it). **(verified, log and code)**

**[F05] Focus arrives as a second commit.** `activateSpace` runs `_flipFirstResponder(null, swap)` and then, outside that commit, `activateCard(focus)` (`deck-manager.ts`, step 7). The 2026-09-24 recording already saw this as the `cross/unchanged` arm after every `cut/declined` (`briefs/workspace-switch-quiet-recording.md`). A body's recede keys on `data-focused`, which it derives from its own deck's `activePaneId` (`tugdeck/src/body/body-root.tsx:166`), fed by the shell's context over the bus; a parked card is told it lost focus at park. So the arriving focused card is drawn receded in the first frame and brightens one or more frames later. **(verified, read)**

**[F06] The faces' retirement and the hand-over are already one transaction, and stay.** `placeCards` hides departing views and stands each arriving face inside one `CATransaction` (`tugapp/Sources/BodyViewController.swift`, `BodyFaceHandOver.handOver`), and `didPaint` swaps a face for its page inside one too. The hand-over's shell snapshot answers in 109 to 215 ms on the user's deck (ten lines in today's log). Nothing here is at fault; it is the mechanism the set reveal of [B04] rides. **(verified, read and log)**

**[F07] The first frame after an AppKit unhide is unread.** A parked body is `isHidden = true` so WebKit throttles it (`applyVisibility`), and is unhidden at the switch. No recording in `briefs/` reads whether the first frame after the unhide shows the view's last layer tree or something else. **(verified, by absence)**

**[F08] No judge reads any of [F01], [F02], [F04] or [F05].** `_row-44.ts` judges a pane's canvas-colour share and its title band's ink; `row-10-*-dormant` judges placement and holes. A card that re-tints, blanks its content, or pops a second after its neighbour passes all of them. **(verified, read)**

---

## Decisions {#decisions}

**[B01] A parked workspace is a finished picture.** What is hidden keeps its own look, its theme, its focus and its content, so the switch shows it rather than remaking it; and what has to load, loads as one. This is the rule the rest derive from, and it is the row for `tuglaws/animation-doctrine.md` D2 and D2a to cite.

**[B02] A body wears its own workspace's theme, always.** The theme a body applies becomes a per-card fact projected from the card's own workspace, the way `paneChromeOf` already resolves `spaceOf(cardId)`, in place of the on-screen theme in `readDeckFacts`. A parked body then never restyles when another workspace's theme is on screen, and the cut's first frame is already in the right tint. A card moved to another workspace restyles then, in the hidden layer. The shell's own flip in the swap commit, and the stand-in and face drawn in the shell's theme, are untouched: they already agree with the arriving cards. Closes [F01], and it is the smallest change with the largest effect on this user's deck.

**[B03] No lid on a dormant reveal.** A revealed dormant body shows what it had, and the catch-up lands in place as any live card takes a frame. The content lid stays only for a page that has never painted (`data-content-painted` absent). This reverses the stage-one reading in [F03], in the open: the mid-turn case is re-read with the fix, and if a transcript landing mid-turn moves something a reader sees, that is the list view's landing to fix, not a reason to blank the card. The user agreed to this on 2026-11-03. Closes [F02].

**[B04] Faced cards reveal as a set, under a horizon.** When a placement faces several cards of one switch, the host keeps every face standing until all of them have content-painted, then swaps faces for pages in one transaction. A horizon of about two seconds, counted from the switch, releases the hold: past it, painted cards show as they come, so a page that never paints holds nothing for ever ([L33]). The set waits on content, not chrome, so a card never pops twice. The faces are loading cards already, and the user has said loading that reads as loading is fine; the cascade is what is not. The number is the arc's to pick from the lane's recorded times and record. Closes [F04]; the mechanism is [F06]'s.

**[B05] Focus rides the swap commit, and a parked body keeps its focused look.** `activateCard(focus)` moves inside the swap's `_flipFirstResponder` so the first notified arrangement names the focused card, and the shell stops telling a parked card it lost focus at park: the workspace record already remembers `focusedCardId`, and the body's `data-focused` holds through the park. The arriving focused card is lit in the first frame. Closes [F05].

**[B06] A reading first, and judges that fail on today's build.** Four frame recordings in the harness, shaped like row 44's burst: a switch between two awake workspaces wearing different themes; a return to dormant session cards; a first visit after launch; a create. Then three bars added to the row-44 and row-10 judges, each run red against the current build before its fix: after the first switched frame, no pane's content region changes its dominant colour; no content box goes surface-blank on a reveal of a painted body; and a switch's faced set swaps to pages in one frame, or past the horizon. The recordings also answer [F07]. Every new test carries `@covers` and stays under the corpus's 20 s budget.

**[B07] The doctrine rows say so.** `tuglaws/animation-doctrine.md` rows D2 and D2a cite this brief beside the two they already cite, with [B01] as the target in words.

---

## Open Questions {#open-questions}

- **What the first frame after an unhide shows ([F07]).** If the recording in [B06] finds a frame of nothing between the unhide and the view's layer tree, the fix is the host's: hide a parked body by opacity or by a cover, not `isHidden`, and the eviction and dormancy clocks keep reading `shown` as they do now ([B04] of the fixups brief). If the frame is clean, nothing changes. The recording settles it either way.

---

## Non-goals {#non-goals}

- **Load time, the lane's width, or a spare per rail card.** How long a page takes to paint is not the subject; [B04] holds the reveal rather than hurrying it. Rejected once already in `briefs/workspace-create-flash-brief.md`.
- **A progress glyph on the lid or the face.** Removed at the user's direction on 2026-10-27 (`e6c94ec2b`): a host-drawn face cannot animate it, and a still glyph read as stuck.
- **Keeping hidden bodies awake to avoid the catch-up.** Dormancy and eviction stay as they are; [B03] changes what a reveal shows, not when a body sleeps.
- **Pre-tinting bodies to the on-screen theme ahead of a switch.** Considered and rejected: it is the current mechanism's premise, and it is what puts the departed tint on the arriving cards. A body's theme is a fact of its workspace, not of the screen.
- **Warming a workspace's pages before showing it.** Rejected in the create brief and stays rejected.

---

## Exit {#exit}

An arc. The first act is [B06]'s four recordings on the current build, which settle [F07] and give each judge its red. Then [B02], the per-card theme, and [B05], focus in the swap commit, which are shell changes and close the two flashes every switch pays. Then [B03], the reveal without its lid, with the mid-turn case re-read. Then [B04], the set reveal in the host, which is the largest piece and the one the create needs. [B07]'s doctrine rows land with the last fix.
