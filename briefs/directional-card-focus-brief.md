# Directional Card Focus, and the Turn Family's Move to the Bracket Band

**Purpose:** There is no way to move the keyboard's focus to the card *above* the one you are reading in a split column — or below it, or left, or right. The deck's two focus-moving chords step rings, which is not what a reader in a split expects. The four-arrow family this wants is blocked by the transcript's turn-navigation chords, so the allocation has to move before the feature can exist.

---

## Purpose {#purpose}

The ask, in the user's words: *"Lets add a keyboard shortcut to move card focus up/down in a split; we don't show the command to move the message transcript up/down (⌥⌘↑/↓), and we should, but we should also figure out how the keyboard shortcut to move the card focus up in a split."*

Two complaints in one sentence, and they turn out to be the same complaint. The deck can move focus only by **ring order** — ⌘⇧[/] around every visible card, ⌥⌘[/] around a stack's depth — and a reader standing in a split column who wants the card above has no gesture at all. The chord a hand reaches for is ⌥⌘↑, and the transcript's Previous Turn already holds it.

The second half is discoverability: the turn verbs exist, are bound, and are on a menu, and a reader in a Session card is still never shown them.

The user's requirement for how the new family must behave, in their words: *"the card that gets the focus is in the direction of the arrow movement, in a way that a user would expect… This is a spatial reckoning."* And on the edge case of a target outside the visible band: *"The imperative here is to give the user what they expect. This will almost certainly be based on what's visible to the user, or what they can conceive of by way of their mental model."*

---

## Evidence {#evidence}

**[F01] The transcript's turn family is fully wired; the Session card offers no door to it.** `PREVIOUS_TURN` / `NEXT_TURN` are ⌥⌘↑/↓ and `FIRST_TURN` / `LAST_TURN` are ⌥⇧⌘↑/↓ (`tugdeck/src/components/tugways/command-registry.ts:2465`), all four `menuEligible`, `mirrored`, gated on `transcriptNavigable`, with `disabledChord: "detach"`. They have menu rows — Session ▸ Go in Transcript (`tugapp/Sources/AppDelegate.swift:1136`), built with empty key equivalents so `applyCommandChords` writes the glyph — and rows in the Keyboard pane under the Session group. What they do not have is any presence on the card itself: only `text-card.tsx` and `file-view-card.tsx` write to `paneTitleBarItemsStore`, so a Session card contributes no title-bar button and no `…` row, and `tug-pane.tsx:554` — which renders `commandShortcut(item.commandId)` beside every contributed row — has nothing to render. **(verified)**

**[F02] Arrow-band occupancy, read out of the registry.** ⌃⌘←/→ the rail pair; ⌃⌘↑/↓ `move-in-column`; ⌃⇧⌘↑/↓ move card to top/bottom; ⌥⌘↑/↓ previous/next turn; ⌥⇧⌘↑/↓ first/last turn. Free: ⌥⌘←/→, ⌥⇧⌘←/→, ⌃⇧⌘←/→. Plain ⌘ and ⇧⌘ arrows are text and selection currency (R2 names this); plain ⌥ and plain ⌃ arrows are closed sets. **(verified — `grep "Arrow" command-registry.ts`, cross-read against `tuglaws/chord-tiers.md`)**

**[F03] ⌃⌘[ / ⌃⌘] and ⌃⇧⌘[ / ⌃⇧⌘] are free, and the bracket band already means "step a series."** ⌘⇧[/] is the lateral card ring, ⌥⌘[/] the stack ring, ⌥⇧⌘[/] the nudge pair (`command-registry.ts:703` — **not** ⌃⌘ brackets, as an earlier reading of that entry's comment had it). Nothing claims the ⌃⌘ or ⌃⇧⌘ bracket sets. **(verified)**

**[F04] ⌘[ / ⌘] cannot carry turn navigation, despite the free pool reserving them for "back/forward."** CodeMirror's `defaultKeymap` binds `Mod-[` / `Mod-]` to `indentLess` / `indentMore`, and Tug installs that keymap in both the composer (`tug-text-editor.tsx:1225`) and the text card (`tug-text-card-editor.tsx:1070`). Promoted, ⌘[ would kill dedent app-wide; left scoped, it would be dead in the composer — which is exactly where turn stepping is used, since a reader steps back through turns with the caret still in the prompt. **(verified for the installs; the `Mod-[` binding is CodeMirror's documented default rather than something measured in Tug — a five-minute check in the running composer would confirm it.)**

**[F05] A `menuEligible` chord displaces rather than shares.** AppKit resolves an `NSMenuItem` key equivalent before the web view sees a keydown ([P15], `keymap-registry.ts` module docs), so two claimants on one chord means one moves or one dies silently — the rule [D175] records for ⌃⌘A. This is why ⌥⌘↑ cannot mean "previous turn in a Session card, focus-up elsewhere," and equally why the turn chords work today from inside the composer. Any new home for them must be promoted for the same reason. **(verified — doctrine, `tuglaws/chord-tiers.md`)**

**[F06] `moveInColumn` already reads a column's arrangement rather than assuming one.** Split, up is up and the commit reorders stored order; stacked, nothing is above anything, so up is toward the front (`tugdeck/src/deck-manager.ts:1942`). Its own comment states the rule: one chord, one meaning per arrangement, never dead on an unsplit slot ([P12]). **(verified)**

**[F07] The existing focus movers are ring-order, not spatial.** `PREVIOUS_TAB` / `NEXT_TAB` step `stepCardRing` over every visible card of every pane — within a pane a tab switch, at a pane's first tab a crossing into the previous pane's last (`deck-canvas.tsx:1417`, and the vocabulary comment at `action-vocabulary.ts:326`). No geometry is consulted, so neither can answer "which card is to my left." **(verified)**

**[F08] The ⌃⌥⌘ set is unavailable on the user's machine.** The user drives special-character entry from Keyboard Maestro on ⌃⌥⌘, machine-wide. The algebra's own answer for this feature derives onto that set — ⌥-as-variant over the Tug tier's ⌃⌘↑/↓, reading as "the same move, the reader instead of the card" — and it is the one set that cannot be granted. **(stated by the user; not verifiable from the code, and the two sitting residents ⌃⌥⌘P and ⌃⌥⌘R are grandfathered.)**

---

## Decisions {#decisions}

**[B01] Directional card focus takes the whole ⌥⌘ arrow band: ⌥⌘←/→/↑/↓ — Focus Card Left / Right / Above / Below.** All four or none. The family's only mnemonic is the geometry itself — the chord points where you are going, the same argument the rail pair's grant rests on — and a mnemonic with a hole in it is a list again. ⌥⌘←/→ are free [F02]; ⌥⌘↑/↓ are taken from the turn family by [B03]. Revisit only if the spatial reckoning [B05] turns out not to be learnable, in which case the family is wrong rather than the chords.

**[B02] The ⇧-extremes of the focus family are not granted, and `move-in-column` keeps all four of its chords.** An earlier draft paid for the focus family by moving the arranging verbs to menu rows on a rate argument (you arrange a column once, you cross it all day — the card-widths precedent). The user's call overrides it: the card-moving commands are worth more to them than Focus Leftmost / Rightmost / Topmost / Bottommost would be. So ⌃⌘↑/↓ and ⌃⇧⌘↑/↓ are untouched, and the extremes of focus travel are simply not commands.

**[B03] The turn family moves whole to the bracket band: Previous / Next Turn on ⌃⌘[ / ⌃⌘], First / Last Turn on ⌃⇧⌘[ / ⌃⇧⌘].** Both sets are free [F03], and the band already carries three step-a-series families, so `[` is back and `]` is forward exactly as it is in the other three — the direction reading survives even though the arrow shape does not. R1 is satisfied: ⇧ is the extreme, sharing its base's key. Neither set collides with CodeMirror [F04], so the chords still fire with the caret in the composer, which is the property the current binding has and must not lose [F05]. The family moves as a unit; splitting it across two bands would leave First/Last with no base to be the extreme of. The cost is the user's own muscle memory, accepted explicitly: *"My muscle memory will recover. I just want the best, most logical set."*

**[B04] The band reading is written down as doctrine: arrows are geometry, brackets are series.** ⌃⌘ arrows move the furniture (a rail on that side, a card up its column); ⌥⌘ arrows move the reader through that same geometry; brackets step rings — cards, stack depth, slots, and now turns. On the ←/→ pair this reads as a pair: ⌃⌘← opens the left side, ⌥⌘← walks into it. `tuglaws/chord-tiers.md` gets this rule and, alongside it, the ⌃⌥⌘ reservation [F08] recorded as a standing constraint — otherwise the algebra keeps deriving chords onto a dead set.

**[B05] Focus travel is a spatial reckoning over the arrangement, not a walk of a ring [F07].** The resolution rule, in order: candidates are the cards a reader can see or conceive of — the front of each column member, plus the members of a **showing** rail; keep those strictly beyond the source's edge on the arrow's axis; prefer candidates whose perpendicular span overlaps the source's, because a card diagonally away is not "to the left" of you; among those, nearest edge wins. The chosen card's pane takes focus through the same activation taxonomy the click path uses (`transferFocusForActivation`), never a raw `activateCard`.

**[B06] The travel remembers where it entered, the way a caret remembers its goal column.** ← then → returns you to the card you started from, and ↑↓ through a column of uneven cards does not drift sideways. The remembered position resets on any focus change that is not itself a directional move — a click, a ring step, a slot assign, a card closing.

**[B07] On a stacked column, ↑/↓ reads as z — front and back.** There is no geometry to consult when every member draws the same rect, and refusing would make the chord dead on an unsplit slot. This mirrors `moveInColumn` exactly [F06] and duplicates the ⌥⌘[/] stack ring deliberately: one gesture, one meaning per arrangement. Reached *laterally*, a stacked column hands focus to its **z-frontmost** member — the same answer the rail pair's three-state ladder gives for which member a side's keyboard lands on.

**[B08] A target outside the visible band is still a target: the band travels so the card is visible when focus arrives.** The user's imperative is what the reader expects from what they can see or conceive, and the flow strip draws the whole arrangement while they are using it — so a slot past the band's edge is inside the mental model, not outside it. Focus landing somewhere invisible is the worse failure, so arrival is what gets fixed: travel the band the way Go to Slot does, and flash the arrival. A hidden **rail** is the opposite case and stays out [B05] — summoning a surface that is not on the deck is ⌃⌘←/→'s job, not a focus move's.

**[B09] A refusal is visible.** At the arrangement's edge, the gesture flashes the blocking pane's border — the answer a refused `moveInColumn` already gives — rather than beeping or doing nothing.

**[B10] The four focus commands are promoted to the Window menu, with empty Swift key equivalents.** R6 makes menu placement half the grant, and the menu is where a chord is discovered. Preemption of scoped bindings is acceptable here: ⌥⌘ arrows are not text currency in any Tug surface (plain ⌥ arrows are word motion; the ⌘ composition is not), and deck-level focus is not a surface's to decline. Empty key equivalents keep every one of them rebindable, the discipline the rail pair and the Go to Slot row follow.

**[B11] The Session card contributes its transcript verbs to `paneTitleBarItemsStore`.** Four rows for the Go in Transcript family, each rendering its chord for free through `commandShortcut` [F01]. This is the answer to the discoverability half of the ask, and it is what makes [B03]'s muscle-memory cost payable: the card itself shows the reader where the verb went.

**[B12] ⌥⇧⌘↑/↓, freed by [B03], stays free.** Recorded as available in `chord-tiers.md` rather than spent in the same change that vacates it.

---

## Open Questions {#open-questions}

- **When nothing overlaps perpendicular, does the move refuse or fall back to nearest-center?** [B05] prefers overlapping candidates, but a ragged arrangement can leave a direction with candidates that are all diagonal. Refusing is predictable; a weighted nearest-center fallback is more useful and less explainable. This wants to be felt in the running app on a real ragged deck rather than settled on paper — a spike of both against three or four arrangements would answer it.
- **Does the remembered entry position [B06] survive the target column changing shape** — a member closing, a split becoming a stack — or is any arrangement change a reset? Reset is simpler and defensible; keeping it is friendlier in the case where a card closes behind you. The answer probably follows whatever the resolver's state ends up living beside.

---

## Non-goals {#non-goals}

- **Granting anything on ⌃⌥⌘.** The algebra's own derivation for this feature lands there and it is unavailable [F08]. This is a standing constraint, not a judgment about this feature, and [B04] writes it down so the next grant does not rediscover it.
- **⌘[ / ⌘] for turn navigation.** The free pool reserves them for a back/forward concept and turn stepping reads like one, but CodeMirror's indent bindings make the chord either destructive or dead exactly where it is used [F04].
- **A fall-through ladder on ⌥⌘↑/↓** — stepping the transcript while it has somewhere to step, then handing the gesture to the deck at the last turn. It matches the rail pair's three-state ladder and it fails the job: mid-transcript in a long session, leaving the card upward costs one press per turn. A gesture usable only from an edge is not a way out of a split.
- **Focus Leftmost / Rightmost / Topmost / Bottommost.** Rejected in favour of keeping `move-in-column`'s chords [B02].
- **Retiring or re-scoping the lateral and stack rings.** ⌘⇧[/] and ⌥⌘[/] stay exactly as they are. A ring and a geometry are different gestures for different intents and the deck wants both; the overlap between ⌥⌘←/→ and the lateral ring is the same overlap ⌘⇥ has with clicking a window.
- **Any wider re-allocation of the arrow bands.** Only the turn family moves.

---

## Exit {#exit}

**An arc.** The work has a natural order, and the doctrine goes first because everything after it cites the doctrine:

1. **`tuglaws/chord-tiers.md`** — the arrows-are-geometry / brackets-are-series reading [B04], the ⌃⌥⌘ reservation [F08], the turn family's move [B03] with its derivation, and ⌥⇧⌘↑/↓ recorded free [B12]. A `[D##]` in `design-decisions.md` for the reallocation.
2. **The registry moves** — the turn family's four bindings to the bracket sets. The Swift side needs no edit: Session ▸ Go in Transcript's items already carry empty key equivalents, so `applyCommandChords` writes whatever the table says. `lintChordCollisions` and the keymap tests are the check.
3. **The spatial resolver** — a pure function from `(deck state, source card, direction)` to a target card id, so [B05]–[B08] are testable against constructed arrangements without mounting the deck. This is where the split/stack fork [B07] and the band-travel case [B08] live, and it is the piece the open questions bear on.
4. **The four commands** — registry entries, `deck-canvas` handlers routed through `transferFocusForActivation`, four Window-menu items in Swift with empty key equivalents [B10], and their `validate` reading the same fact the resolver reads so an item is live exactly when its chord would act.
5. **The Session card's title-bar rows** [B11] — independent of everything above and landable on its own.
6. **App-tests** with `@covers` for the resolver's split, stacked, ragged, and rail-crossing cases, and for the refusal flash [B09].

Steps 1–2 are one shape of change (allocation), 3–4 another (the feature), and 5 is separable — worth landing in that order so a bisect can tell a chord problem from a geometry problem.
