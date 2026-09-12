# The fold's chord and its motion: ⌃⌘Y, and a transcript that holds still

**Purpose:** Two things are wrong with the Session card's fold. Its chord, ⌥⌘M, is not Tug's to bind — AppKit claims it — so the gesture needs a new home. And the fold's motion is distracting: the transcript's contents slide and re-flow inside the card for the whole length of the tween, in both directions, when the only thing that should move is the card's edge.

---

## Purpose {#purpose}

In the user's words:

> - Keyboard shortcut for session card fold/unfold can't be ⌥⌘M. Make a suggestion for a better combo.
> - Fold/unfold animation needs improvement. Internal content moves while the card is changing shape, which is *very distracting*.

And, on the chord, after the candidates were weighed:

> You must not touch ⌃⌘M. That is sacred for writing the commit message. We need a different shortcut. How about ⌃⌘Y? Is there a clever mnemonic we can come up with for this? The shape of the glyph looks good, which is why I like it.

The feature was *minimize* and is now *fold* (`briefs/session-fold-rename-brief.md`); the fold itself, its Z2 seat and its terminal state are landed and not in question. This is the chord that opens it and the picture it draws while it moves.

---

## Evidence {#evidence}

### The chord

**[F01] ⌥⌘M is bound in three places, all of which say the same thing.** The registry entry at `tugdeck/src/components/tugways/command-registry.ts:1740` (`TOGGLE_SESSION_FOLD`, `menuEligible`, `menuItemId: "session.fold"`), the Session menu row at `tugapp/Sources/AppDelegate.swift:1176` (`keyEquivalent: "m"`, `[.command, .option]`), and the derivation paragraph in `tuglaws/chord-tiers.md` under "The two operators", which reads ⌥⌘M as the *form* half of the variant rule over ⌘M Minimize. The action-vocabulary comment at `action-vocabulary.ts:596` and the card's responder comment at `session-card.tsx:5111` both name the chord in prose. **(verified)**

**[F02] The chord is spent outside Tug.** AppKit synthesizes *Minimize All* as the ⌥-alternate of Window ▸ Minimize, so ⌥⌘M resolves at the system's menu layer before Tug's Session menu sees it. This is the same shape as the ⌃⌥⌘ reservation the doctrine already records: a chord that never arrives is indistinguishable from a command that does not exist. **(inference from the user's report and AppKit's documented Window-menu behaviour; the user's own keyboard is the confirmation, and the remedy does not depend on which exact thing ate it)**

**[F03] Every F-shaped chord is spoken for, and the doctrine already said so.** ⌘F is Find, ⌃⌘F is Enter Full Screen (`command-registry.ts:2237`, macOS convention, the resident that anchors the ⌃⌘ tier), and the ⌥⌘M paragraph in `chord-tiers.md` rules ⌥⌘F out by name: a ⌥ twist of ⌘F "has to read as a variant of opening the find bar." Fold does not twist Find, so ⌥⌘F fails **R1** where it counts even though it shares the key. **(verified)**

**[F04] ⌃⌘M is taken, and taking it would break what holds it.** `COMMIT_AUTO_MESSAGE` (Generate a Commit Message) is bound to ⌃⌘M at `command-registry.ts:2356`, scoped to the composer in commit mode. A `menuEligible` Fold on the same chord would become an AppKit key equivalent that resolves before the web view sees the keydown, so the scoped binding would reach nothing — the [D172]/[D175] trap the entry's own comment records. The user has ruled the chord untouchable regardless. **(verified)**

**[F05] ⌃⌘Y is free everywhere a chord can be claimed.** The registry's ⌃⌘ letters are I, U, C, H, K, F, M, A, P, R and the brackets (`grep -n "ctrl: true, meta: true" command-registry.ts`); the Swift menus' ⌃⌘ key equivalents are C, H and F. ⌘Y sits in the doctrine's free pool as one of the two "safest" plain-⌘ slots. ⌃⌘Y is not on the macOS reserved list. **(verified)**

**[F06] ⌃⌘ is a base tier, so a grant there needs a reading, not a derivation.** R1 governs ⇧- and ⌥-composed chords only; the Tug tier's letters are chosen by mnemonic (C changes, H history, I AI, U usage). The Session menu's own chords are ⌃⌘C and ⌃⌘H, so a ⌃⌘ Fold sits in the tier its menu already speaks. **(verified, from `chord-tiers.md` "The two base tiers" and "The rules")**

### The motion

**[F07] The frame's tween is not the problem.** `session-card.css:1531-1600` animates exactly one property — the entry region's `grid-template-rows: 1fr → 0fr` — on the imposer settle's own clock, and the CSS block's argument that "very little is animated here, and that is the point" holds. Z2 rides the closing edge because it sits at the end of `.session-card-top-column`, after the view slot. **(verified)**

**[F08] The transcript's scrollport is resized on every frame of the fold.** The column's floor stands down (`.tug-pane[data-folded="true"] .session-card .session-card-top-column { min-height: 0 }`) and `.session-view-slot` is `flex: 1 1 0`, so the slot — and the `TugListView` scroller inside it — shrinks continuously with the frame for the ~400ms of the motion. **(verified)**

**[F09] Each of those resizes moves the content.** The list view's container `ResizeObserver` (`tugdeck/src/components/tugways/tug-list-view.tsx:3628`) answers every delivery with `maybePinToBottom()` and `scrollTick()`. For a reader at the live edge the pin slides the text upward by exactly the amount the viewport shrank, every frame — that is the motion the user is seeing. For every reader the tick re-windows: rows mount, unmount and re-measure under the closing edge. **(verified by reading; the mechanism is unambiguous)**

**[F10] The unfold is the same defect for longer.** `data-fold="settled"` comes off at frame 0 of the unfold (`session-card.tsx:3606` writes `"moving"`, which removes the `display: none` at `session-card.css:1584`), so the slot gets its box back while the frame is still folded and then *grows* for the whole tween — a viewport a few pixels tall at the first frame, pinning and re-windowing all the way up. The hidden-box restore that landed with `ses-min-reveal` fires at that first frame, against that tiny viewport, and then watches the tween undo the neighbourhood it restored. **(verified)**

**[F11] The composer is a smaller instance of the same thing.** `.session-card-entry-region > *` is `min-height: 0; overflow: hidden` during the motion, so the composer's own box shrinks with its grid row rather than being clipped at a fixed size. Its content is short and the effect is mild, but the cause is identical. **(verified)**

---

## Decisions {#decisions}

### The chord

**[B01] Fold Session moves to ⌃⌘Y.** The Tug tier, where Fold's own menu neighbours already live ([F06]), on a letter nothing claims ([F05]). A base-tier grant needs no ⌘ base to compose from, so this is not an anomaly and needs no Known-anomalies entry: it is a reading, like every other ⌃⌘ letter. ⌃⌘M is not touched ([F04]).

**[B02] The mnemonic is the glyph: a Y is a fold drawn.** Two arms meet and continue as one stem — the open card's two regions, transcript and composer, closing down onto its one bar. This is a *shape* mnemonic where the tier's other letters are initials, and that is worth writing into `chord-tiers.md` as its own kind of reading so the next reader knows it was chosen rather than left over. It is also what makes the chord teachable: the user named the glyph's shape as the reason before any mnemonic was offered.

**[B03] The doctrine paragraph is rewritten, not deleted.** The ⌥⌘M paragraph under "The two operators" in `tuglaws/chord-tiers.md` keeps its "why not F" argument verbatim — it is still true and it is what stops ⌥⌘F being re-proposed — and its ⌘M-kinship reasoning becomes the record of a derivation that landed on a chord Tug cannot bind. The paragraph ends with where Fold went and why: the same situation as the ⌃⌥⌘ reservation, answered the same way. The Session menu row, the registry binding, and the three prose mentions ([F01]) follow the chord.

### The motion

**[B04] The transcript is a picture for the length of the motion, not a live scroller.** The slot keeps flexing to zero exactly as it does now, so Z2's ride is unchanged ([F07]); the slot's *child* — the transcript host the `TugListView` fills — is given a frozen pixel height for the duration, and the slot's existing `overflow: hidden` clips it. The scroller's `clientHeight` never changes, so the container observer never fires: no pin, no re-window, no re-measure, nothing inside moves ([F08], [F09]). The card's edge sweeps over a still image. The same treatment goes on `.session-card-entry-region > *` for the composer ([F11]), at no extra cost.

**[B05] The frozen height is a custom property on the card root, written by the fold effect.** The layout effect at `session-card.tsx:3606` that writes `data-fold="moving"` measures the slot's current height and writes it as `--session-fold-slot-height` (and the entry region's as `--session-fold-entry-height`) in the same pass, before paint; `land()` clears both. DOM writes, never React state ([L06]); the motion stays in CSS ([L13]). The CSS keys the frozen `height` on `[data-fold="moving"]`, which already scopes every other in-flight rule.

**[B06] The unfold reuses the height cached at the previous fold-in.** At unfold time the slot is `display: none` and its open height cannot be read ([F10]). The value taken at fold-in is exact unless the pane's height changed while the card was folded, and when it is not exact the error lands as one correction on the last frame — the reveal seam's own restore, against the geometry it was measured for — instead of 400ms of churn. With no cached value (a card that mounted folded, opening for the first time) the freeze is skipped and the motion is what it is today; it is no worse than now. This also makes the reveal seam's job clean: the box goes from hidden to its full height in one step and the restore lands once.

**[B07] The picture is anchored to the slot's bottom edge.** Frozen at the top, the fold eats the newest text first and leaves the oldest visible last. Frozen at the bottom (`margin-top: auto` on the child while moving), the fold eats upward and the live edge is the last thing visible before Z2 closes over it — the transcript swallowed by the instruments, which is the reading the Z2 seat was designed for, and a Session card's reader is usually at the live edge. Chosen provisionally: it is a one-property difference, and both should be looked at in the running app before the arc lands it (see Open Questions). The composer's child is anchored at the top, so the caret line stays visible longest.

---

## Open Questions {#open-questions}

- **Which edge the clip eats, seen rather than argued.** [B07] chooses the bottom anchor on reasoning; the two are one property apart and the difference is entirely visual. The arc should build both and look before settling — this is a look-at-it decision, and the brief's choice is the default, not the verdict.

---

## Non-goals {#non-goals}

- **⌥⌘F.** The user's first instinct and the letter the verb wants. Ruled out by the doctrine's own paragraph ([F03]): it shares ⌘F's key without twisting Find, which is R1's failure mode, and granting it would spend a Known-anomalies entry to buy a letter. Recorded so it stays rejected.
- **⌃⌘M, with Generate a Commit Message evicted to ⌃⌘G.** Tier-correct and derivable, but ⌃⌘M is the user's commit-message chord and is not to be moved ([F04]). Not to be re-proposed.
- **⇧⌘M.** In the free pool and one modifier from muscle memory, but ⇧ would be doing ⌥'s work — a counterpart slot carrying a variant reading — and a shape mnemonic on a free base-tier letter is the cleaner grant. Dropped once ⌃⌘Y was on the table.
- **Fading the transcript out during the fold.** One property and six lines, and it hides everything — but it is a cover-up: the list still pins and re-windows sixty times behind the fade, the unfold still lands its restore against a moving viewport, and it adds a second animated property to a block whose whole argument is that only the frame animates. A short fade *on top of* the freeze, to soften the clip edge, is a smaller and separate question, worth trying after and not instead.
- **Keeping `display: none` on the slot until the unfold ends.** Would make the unfold's reveal a single step with no cached height needed, at the cost of the transcript popping in at the end rather than being revealed — the half of the beat a reader is most likely to be watching. [B06]'s cached height gets the same single-step restore without giving up the motion.
- **Retuning the frame's tween, its settle clock, `transitionend` or the backstop.** All as landed; the frame's motion was never the problem ([F07]).
- **The reveal seam itself.** `lib/list-view-reveal.ts` is right as it stands; [B04]–[B06] change *when* it fires, not what it does.

---

## Exit {#exit}

An arc, two halves that do not depend on each other and can land in either order.

The chord half touches five places and no behaviour: the registry binding at `command-registry.ts:1740`, the Session menu row at `AppDelegate.swift:1176`, the `chord-tiers.md` paragraph ([B03]) with the glyph reading written in ([B02]), and the three prose mentions of ⌥⌘M ([F01]). `lintChordCollisions` and the keymap pane are the checks.

The motion half is `session-card.tsx`'s fold effect and `session-card.css`'s in-flight rules: the measure-and-write at fold start, the cached height for the unfold, the frozen-height rules keyed on `[data-fold="moving"]` for the slot's child and the entry region's child, and the anchor ([B07]). Verification is on the running app: fold and unfold a card with a long transcript at the live edge and parked in history, and watch that nothing inside the card moves while its edge does — then look at both anchors before choosing.
