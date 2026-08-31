# Chord Tiers

*Chord assignment is an algebra, not a list. Two base tiers and two operators generate every modifier set Tug uses, so every chord's shape is explainable in one sentence — and a chord whose shape cannot be derived is a chord that was assigned by whoever got there first.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md). Authoring contract: [commands.md](commands.md). Menu projection and the generated chord table: [menus.md](menus.md). Naming: [action-naming.md](action-naming.md).*

---

## Why an algebra

[L30] made every chord a registry fact, which fixed *where* chords live without saying anything about *which* chord a command should get. So the chords themselves accreted: a command took whatever was free near a mnemonic letter, and the modifier stack grew by one whenever plain ⌘ was already taken. The result read as a list of memorized facts, and a list is unexplainable by construction — a user cannot predict an unfamiliar chord, and an author cannot tell a good grant from a bad one.

The algebra replaces the list. Each modifier set has a meaning, meanings compose, and a proposed chord is checked by deriving it rather than by scanning for a collision. Collision-checking still happens (`lintChordCollisions`), but it answers a different question: the lint says the chord is *available*, the algebra says the chord is *right*.

The algebra was already half-latent in shipped bindings — ⌘V → ⌥⌘V → ⌥⇧⌘V, ⌘Z → ⇧⌘Z, ⌘W → ⌥⌘W — which is the argument for adopting it rather than inventing something. Writing it down moved nine chords ([D126]) and explained the rest.

---

## The two base tiers

**⌘ — the universal tier.** Verbs any Mac user already knows (Save, Find, Copy, Close, Quit) plus the highest-frequency Tug verbs (Focus Prompt ⌘K, Reveal Stack ⌘R). Its digits are places: ⌘1–9 are slots, ⌘0 is actual size — see "The digit row" below for what a digit means across tiers.

**⌃⌘ — the Tug tier.** Tug's own machinery: surfaces, shades, modes, themes, app-specific features. This is where Tug gets to be Tug without colliding with thirty years of ⌘ convention. ⌃⌘F Full Screen is the macOS-conventional resident that anchors the tier and proves ⌃⌘ letters reach the web view intact.

## The two operators

Each operator adds one modifier and keeps the key.

**⇧ — the counterpart.** Reverse, widen, or undo the base command: ⌘Z → ⇧⌘Z Redo, ⌘G → ⇧⌘G Find Previous, ⌘S → ⇧⌘S Save As, ⌃⌘A Claim All → ⌃⇧⌘A Disclaim All.

**⌥ — the variant.** Same verb, altered object or form: ⌘W Close → ⌥⌘W Close All, ⌘V Paste → ⌥⌘V Paste as Quote, ⌘N New Session → ⌥⌘N New Text File, ⌘H Hide → ⌥⌘H Hide Others.

## The composed sets

Composed sets are never assigned fresh — each one *means* its composition, and a chord that lands in one without a base to compose from is a chord in the wrong tier.

| Set | Reading |
|---|---|
| ⌥⇧⌘ | Both twists at once. "…as Plain Text" is always ⌥⇧⌘ (⌥⇧⌘C, ⌥⇧⌘V — the latter matching macOS "Paste and Match Style" exactly). First/Last Turn ⌥⇧⌘↑/↓ are the ⇧-extremes of Previous/Next Turn ⌥⌘↑/↓. |
| ⌃⇧⌘ | The counterpart of a Tug-tier command. Debut resident: Disclaim All ⌃⇧⌘A, the counterpart of Claim All ⌃⌘A. |
| ⌃⌥⌘ | The variant or advanced form of a Tug-tier command — the "super-advanced" tier. Debut resident: Cycle Permission Mode ⌃⌥⌘P, since permission modes govern agent autonomy, the quintessential expert feature. |

## The digit row

**A digit indexes an ordered set; the tier says which set.** ⌘1–9 and ⌃⌘1–6 index the same ordered set — the deck's slots — and the tier alone says which reading of it: ⌘*n* sends the card to slot *n*, ⌃⌘*n* sends the reader there. The same gesture (reach for the *n*th thing) read against the tier's own subject: the ⌘ tier arranges the deck, the ⌃⌘ tier is Tug's machinery for how you are standing in front of it. ⌘0 stays actual size, which is the zoom family's own zero rather than an index into anything.

This generalizes the older wording, "digits are places" ([D130]). Places was only ever true of the tier that had digits; stated flatly it made ⌃⌘ digits unreachable by derivation. The narrower reading survives inside the new one — ⌘*n* *is* a place — and the wider one is what makes the second row explainable rather than remembered. It has since come all the way back around: the ⌃⌘ digits are places too now, read as *where the reader stands* rather than *where the card goes*, which is the tightest form the rule has taken.

The rule that keeps this from becoming a pool: a digit family must be an **ordered set the user already sees in that order**. Slots run left to right across the deck, and the flow strip draws that order at the bottom of the canvas while a reader is using it. A family whose order is arbitrary has no business on the digit row, because the whole value of a digit is that you can predict which one before you press it.

**⌥⌘1–3 was once proposed for the card widths, and R1 is why it failed.** ⌥ is the variant operator, so ⌥⌘*n* must read as a variant of ⌘*n* — a variant of Move Card to Slot *n*. Card width is a different verb on a different property, so the composed set had no base to compose from: the modifier stack would have been climbed purely because plain ⌘ digits were taken, which is the accretion R1 exists to stop. The widths went to ⌃⌘1–3 instead, and later gave those up as well ("The card widths gave the digits up", below) — the digit row belongs to the deck's slots on both its tiers.

## The closed sets

**Plain ⌥ letters are closed forever.** They type glyphs — ⌥e is é, ⌥n is ñ — and a binding there breaks text entry for anyone who uses the option layer as designed.

**Plain ⌃ letters are closed forever.** They belong to the text caret: the emacs set, of which ⌃U and ⌃W are declared substrate currency in `ACTIONS_OUTSIDE_THE_TABLE` ([commands.md](commands.md), "What is not a command").

One non-printing exception is grandfathered, and grandfathered is the whole justification — it would not be granted today: **⌥⇥** Cycle Focus Mode. (⌃` Cycle Panes was the other, until the Window-menu rework ([D129]) retired the command and returned the chord to the closed set.)

---

## The rules

**R1 — The pairing rule.** A ⇧- or ⌥-composed chord must share its key with the base command it twists. If a proposed chord has no base to vary, it is either a plain-⌘ candidate or a ⌃⌘ Tug-tier command. The modifier stack is never climbed merely because plain ⌘ was taken; that is exactly the accretion the algebra exists to stop.

**R2 — The arrows exemption.** Arrow chords are exempt from R1. ⌘↑/↓ is text and history currency in the composer, so the ⌥⌘↑/↓ turn-navigation family has no ⌘ base to pair with. ⇧ still means "to the extreme" on arrows, which is how ⌥⇧⌘↑/↓ reads as First/Last Turn.

**R3 — The scarcity rule.** Plain ⌘'s remaining free slots go only to commands a user hits many times an hour. Everything else enters through its semantic tier. A plain-⌘ grant spends a finite resource, so the frequency claim is part of the grant, not an afterthought.

**R4 — Closed sets stay closed.** Plain ⌥ letters and plain ⌃ letters are not a pool. A command that "really wants" one wants a different chord.

**R5 — ⌘. parity.** Wherever ⎋ *dismisses a surface or backs out of a mode* — alerts, sheets, popovers, placards, context menus, overlays, lightboxes, completion popups — ⌘. does the same thing. This is a law of the app, not a per-component choice, and it is satisfied by the shared registry-backed matcher `isCancelChordEvent` (`keymap-registry.ts`), never by a hand-authored `metaKey && key === "."` test. The line has one exclusion: ⎋ that *reverts an in-field edit* (the filter field, the value input, the slider's in-flight scrub) stays Escape-only. That ⎋ is form-control currency inside a typing surface — it edits the value rather than leaving the surface — and ⌘. there would be both surprising and outside macOS convention.

**R6 — Menu placement is a chord decision.** A menu-eligible chord resolves at the native menu layer before any scoped binding ([commands.md](commands.md), four-layer resolution), so a chord grant records both its tier justification *and* its `menuEligible`/`scope` choice. One decision, not two: choosing the menu is choosing to preempt every scoped binding regardless of focus.

---

## The free pool

Plain ⌘, for future grants under R3.

| Slot | Standing |
|---|---|
| ⌘D, ⌘Y | Safest — weak conventions elsewhere. |
| ~~⌘E~~ | **Spent** — `find-selection`, Use Selection for Find. The honest use the slot was held for; see below. |
| ⌘B, ⌘U | Hold in reserve — bold/underline, and Tug renders markdown. |
| ⌘P | Hold in reserve — the print reflex is strong. The only accepted repurposing is a command palette. |
| ⌘' ⌘; ⌘\ | Free punctuation. |
| ⌘[ ⌘] | Reserved for any future back/forward navigation concept. |

Plain-⌘ digits are fully spent: ⌘1–9 are slots, ⌘0 is actual size. ⌃⌘1–6 take the reader to those same slots; ⌃⌘7–9 and ⌃⌘0 are free, and free for an *ordered set* under the digit-row rule above — not as loose slots. (⌃⌘7–9 are really the tail of the Go to Slot set, held for an arrangement wider than six-up rather than open for anything else.)

**Freed by [D126]** and returned to the pool: ⇧⌘P, ⇧⌘C, ⇧⌘H, ⇧⌘M, ⌥⌘T, ⌘I.

---

## macOS reserved — never bind

⌘Space, ⌘⇥, ⌘` · ⌃↑ ⌃↓ ⌃← ⌃→, ⌃Space · ⌃⌘Q (lock screen), ⌃⌘D (dictionary), ⌃⌘Space (emoji) · ⇧⌘3 ⇧⌘4 ⇧⌘5 (screenshots), ⇧⌘Q (log out), ⇧⌘/ (Help search) · ⌥⌘⎋ (force quit).

---

## Worked example: the nine moves of [D126]

The algebra's first application. Each row's rationale is a derivation, not a preference.

| Command | Was | Is | Derivation |
|---|---|---|---|
| `select-composer-route:prompt` | ⇧⌘P | **⌃⌘P** | Route selection is Tug machinery — Tug tier. ⇧ was carrying nothing; there is no ⌘P base for Prompt to be the counterpart of. |
| `cycle-permission-mode` | ⌃⌘P | **⌃⌥⌘P** | The advanced form of a Tug-tier command, and the tier's debut resident. Vacating ⌃⌘P is what lets Prompt Route land on its own tier. |
| `toggle-changes-view` | ⇧⌘C | **⌃⌘C** | A shade toggle is Tug machinery. |
| `toggle-history-view` | ⇧⌘H | **⌃⌘H** | The twin of Changes; it moves with it. |
| `commit-auto-message` | ⇧⌘M | **⌃⌘M** | Joins the Changes cluster on one tier: ⌃⌘C the shade, ⌃⌘M the message, ⌃⌘A the claim. Stays composer-scoped. |
| `claim-all-changes` | — | **⌃⌘A** | New. One mnemonic neighborhood with ⌃⌘C and ⌃⌘M. |
| `disclaim-all-changes` | — | **⌃⇧⌘A** | New. R1: the ⇧-counterpart of ⌃⌘A, sharing its key, one finger from its pair. |
| `next-theme` | ⌥⌘T | **⌃⌘T** | Themes are Tug machinery. ⌥ was carrying nothing — there is no ⌘T base of which Next Theme is a variant. |
| `insert-file` | ⌘I | **⌃⌘I** | Inserting a file reference into the composer is Tug machinery, not a many-times-an-hour universal verb (R3), and the move frees ⌘I from its italic baggage. |

**⌃⌘A and ⌃⇧⌘A are not an inverse on one set.** ⌃⌘A acts on what is *not yet* this session's — the unattributed and orphaned buckets together — and ⌃⇧⌘A on what *is*. ⇧-as-counterpart is carrying "the opposite bulk verb of this shade", not "the same set, reversed". R1 promises a shared key and an opposite sense; it does not promise set inversion, and this pair is the reason to say so out loud.

**Ratified unchanged:** ⌥⌘/ Show DevTools against ⌘/ Command Picker; the ⌥⌘↑/↓ + ⌥⇧⌘↑/↓ turn family (R2).

---

## The ⌃⌘ reading, and the rail pair inside it

**⌃⌘ carries Tug's layout and card-posture vocabulary** — how the deck is arranged and how a card stands on it. The rail pair below is one *family* within that reading, not the whole of it.

This widens an earlier wording that named the tier's letters as the sidebar-toggle grammar outright. That was the same mistake "digits are places" made on the digit row ([D130]): true of the family that happened to be there first, and stated flatly it made the next honest grant underivable — bullseye is a card's posture on the deck, unmistakably Tug's own layout machinery, and under the narrow reading it would have had to be either a sidebar toggle (which it is not) or an unexplainable exception. The wider reading is what the promotion below then rested on: a rail toggle is layout vocabulary whatever key it takes, so it could leave the letters entirely and stay on this tier.

### The rail pair, and the sidebar-toggle family it replaced

**The keyboard addresses the RAIL, not the card standing on it.**

| Command | Chord | Derivation |
|---|---|---|
| `toggle-rail:left` | **⌃⌘←** | Tug tier: a rail is layout vocabulary, alongside ⌃⌘↑/↓ `move-in-column`, whose vertical axis these complete horizontally. Arrows are R1-exempt under R2, and the mnemonic is the geometry itself — the chord points at the edge it opens. |
| `toggle-rail:right` | **⌃⌘→** | As above, the other edge. |
| `new-jot` | **⌘J** | Plain-⌘ under R3: capture is reached mid-thought, many times a day, and a jot you must open a card to write is a jot you don't write. Claims ⌘J out of the free pool — an honest use, though not the jump/go-to one the pool's annotation anticipated. Untouched by the promotion below: a capture verb is not a toggle. |

⌃⌘ arrows are neither bound in Tug nor on the macOS never-bind list, which reserves **plain** ⌃-arrows for Spaces and Mission Control rather than the ⌘ composition — the argument `move-in-column` already made on the vertical pair. Both are `menuEligible` with **empty** Swift key equivalents, so `applyCommandChords` writes them and both stay rebindable; see the shade-toggle anomaly below for what the alternative costs.

**The family this replaced died of arithmetic.** ⌃⌘⟨letter⟩ named a *sidebar card*, and toggling one showed or hid its rail: ⌃⌘L Show Lens (moved off ⌥⌘L to join the grammar), ⌃⌘J Show Jots, ⌃⌘O Show Overview, plus ⌘L Focus Lens beside them. The grammar was said to be the point — a pair makes each chord teach the other, and it leaves room for a third card to arrive already knowing its chord — and that reasoning held exactly as far as three. The sidebar then grew from three cards toward six, and the letters the new cards want are spent (⌃⌘C is the Changes shade, ⌃⌘T is Next Theme) or forbidden (⌃⌘D is the system Dictionary, on the never-bind list above). A grammar whose next honest grant is underivable is not a grammar; it is three chords and a coincidence.

A chord per SIDE does not grow at all. Six sidebar cards need the same two keys three do, and the two are a closed set because the deck has two edges — which is the property the letter row could never have.

**So the per-card toggles took the demotion the card widths took** ("The card widths gave the digits up", below): `toggle-lens`, `toggle-jots`, `toggle-overview` and `focus-lens` keep their menu rows with `bindings: []` — a command with no *default* chord, not one that refuses a chord, so the keymap pane can still bind any of them — and ⌃⌘L, ⌃⌘J, ⌃⌘O and ⌘L return to their pools. The rate argument is the same one the widths rested on: the user does not reach for these. (`toggle-lens` and `focus-lens` go entirely when the Lens card does; until then they stand chord-less.)

**The three-state ladder survives the promotion, addressed one place up.** A rail that is not showing opens and takes the keyboard; a rail showing but not holding it takes it; a rail that holds it goes away. The member the keyboard lands on is the side's **z-frontmost**, which is the one answer well defined in both arrangements — stacked it is the member you can see, split it is the one the stack badge's picker checkmarks. Showing a rail brings back the members that were standing when it was hidden, recorded at the hide; the side's stored order and shares are untouched throughout, so nothing about the arrangement is spent by the round trip ([L23]).

---

## The Go to Slot row

⌃⌘⟨digit⟩ names a slot and takes the reader to it.

**Named for the arrival, not the geometry.** The band travels to put the named slot as near the middle as the strip allows, and the clamp pins the strip's two ends flush — so the first and last slot come to rest against their end rather than in the middle. That is the right behaviour (the strip is already showing everything it has that way), which makes *Center Slot 1* a row that cannot do what its label says. A reader who typed it and watched slot 1 land at the left edge would reasonably conclude the command was broken. *Go to* promises arrival and nothing more, which is the whole of what the verb owes. The arithmetic is still `stripCenterOffset` — the function centers and then clamps, and naming a function for its rule is not the same as naming a menu row for its outcome.

**The arrival is answered.** Choosing the row or typing the chord flashes what it landed on — the pane's accent ring if a card stands there, the vacancy badge's if the place is empty. The band moving is the only thing this verb does, and on a deck of similar cards that is not enough to tell a reader which one they asked for; the flash is the same answer `assign-slot` gives when a card is sent somewhere.

| Command | Chord | Derivation |
|---|---|---|
| `go-to-slot:1` | **⌃⌘1** | Tug tier: where the reader stands in the arrangement is Tug's own layout vocabulary, alongside ⌃⌘←/→ and ⌃⌘T. The digit is the slot's own number. |
| `go-to-slot:2` … `go-to-slot:6` | **⌃⌘2**–**⌃⌘6** | As above. Six because six-up is the largest arrangement. |

**This is the digit-row rule at its tightest.** ⌘*n* and ⌃⌘*n* index the *same* ordered set — the deck's slots — and the tier alone says which reading: ⌘*n* sends the CARD to a place, ⌃⌘*n* sends the READER there. Same set, same digits, one modifier of difference.

Six rows rather than the slot family's nine, and for the opposite reason. ⌘1–9 is bound in full so an out-of-range digit is inert rather than beeping; these are menu rows, and a row for a slot no arrangement can hold is a permanently dark row.

The gate is the **arrangement's**, not the selection's: travel moves the band and touches no card, so the row is live on a deselected deck, and dark under fit — where every anchor is inside the band already and there is nothing to travel to.

**These are `menuEligible` with empty Swift key equivalents** (Window ▸ Go to Slot *n*), so `applyCommandChords` writes them and all six stay rebindable — the discipline the rail pair follows, and the one the shade toggles below do not.

R6 says the menu placement is half the grant, so: promoting these preempts every scoped binding on ⌃⌘1–6, and that is the intent. It is safe here precisely where it was not for the slot family — ⌘1–9 stay chord-only because surfaces like the PDF viewer decline them by hand to leave the digits with the deck, and a menu item would take that choice away from every surface that comes after. Nothing in the app claims ⌃⌘ digits: no viewer, no text surface, no CM6 keymap.

### The card widths gave the digits up

⌃⌘1/2/3 named the three content widths until the row above took them ([D130] is unchanged; only its chord is gone). The argument is about *rate*, not importance: a card is given its size once and read at it for the rest of the session, while a reader crosses an overflowing arrangement many times an hour. A chord is not a label for how much a command matters — it is a claim on a scarce row of keys, and the scarce row goes to what the hand reaches for.

Slim / Comfy / Wide keep their **Window-menu rows** and the title bar's width popup, which are the doors a once-a-session verb wants; the rows are check-markable, which is the shape the popup already has, and that visible current value is worth more to this verb than a no-look chord was. The registry entries carry `bindings: []` — a command with no *default* chord, not one that refuses a chord — so the keymap pane can still bind them, and the Swift items are still constructed with empty key equivalents so whatever the table says is what gets written.

*Three commands and not one cycling command* still holds for the widths, and the reasoning survives the demotion: the set is static and small, and a cycle you have to know your place in is one you have to look at — the same argument that makes Next Card in Stack a true ring rather than a swap.

## Known anomalies

Recorded so a reader takes them as debt rather than as precedent.

*(Resolved: Cascade ⌃⌥C and Tile ⌃⌥T once sat here — ⌃⌥ with no ⌘, a set the algebra does not generate, invisible to the keymap pane. The menu-by-menu audit resolved the anomaly by deletion: both commands were removed with the Window-menu rework ([D129]), the Layouts system being how Tug arranges the deck.)*

**⌥⌘/ Show DevTools is a wink, not a derivation.** ⌘/ opens the command picker and ⌥⌘/ opens DevTools; DevTools is not a "variant" of the picker in any sense R1 recognizes. It is ratified because the pairing reads as a joke a developer gets, and because the Maker menu is debug-only.

**⌥⌘U / ⌥⌘L are a mnemonic pair, not a derivation.** Make Uppercase and Make Lowercase are text-editing verbs on the ⌘ tier's own subject, but R1 wants a ⌘U and a ⌘L for ⌥ to twist and there is neither: ⌘U is held in reserve for underline in the free pool, and ⌘L is Focus Lens, which lowercasing a selection is no variant of. The grant rests on the initials — U for upper, L for lower — and on the symmetry, each chord teaching the other the way the rail pair does. The debt it leaves is on ⌘U: if the reserve is ever spent on Underline, ⌥⌘U will read as *that* command's variant and the pair will have to move together. Both are `menuEligible` with empty Swift key equivalents, so `applyCommandChords` writes them and both stay rebindable.

**⌘T is a plain-⌘ grant that only exists in debug builds** (`maker.newCardInPane`, New Card in Active Pane). It would not survive R3 in a release menu; it survives because the Maker menu is not in one.

**The shade toggles' menu claim cannot be detached.** `toggle-changes-view` and `toggle-history-view` each carry a registry binding that is *not* `menuEligible` **and** a Swift construction literal on their menu item. So `menuChords()` never claims `session.toggleChanges` / `session.toggleHistory`, and therefore never publishes the `null` that would detach the construction literal. A user who rebinds either command leaves the old chord standing on the menu item, where AppKit keeps eating it before the web view sees a keydown — the rebind appears to do nothing. This is pre-existing and not introduced by [D126], but it is the one place where "every chord is the user's to move" is not yet true end to end, so it is named here rather than left for a reader to infer.

---

## Cross-References

- [L30] — every user-invocable command is a registry entry; every emitter goes through the two funnels
- [D126] — the adoption of this algebra and the nine moves it drove
- [D130] — the digit row generalized, and the card-width chords it granted
- [commands.md](commands.md) — the authoring contract: the entry shape, "Adding a command", the four-layer chord resolution order, the lints
- [menus.md](menus.md) — the menuState wire contract and the generated chord table
- `tugdeck/src/components/tugways/command-registry.ts` — the table and `lintChordCollisions`
- `tugdeck/src/components/tugways/keymap-registry.ts` — `resolveChord`, `commandShortcut`, `isCancelChordEvent`
- `tugdeck/src/components/tugways/chord-format.ts` — chord identity (`chordMatchesEvent`), display (`formatChord`), and the Swift key-equivalent conversion

---

## The bullseye chord

⌃⌘B puts the focused card in **bullseye** — centred in the band at the comfy width with every other surface receded — and takes it back out ([D131]).

| Command | Chord | Derivation |
|---|---|---|
| `toggle-bullseye` | **⌃⌘B** | Tug tier: a card's *posture* on the deck is Tug's own layout machinery, alongside the Go to Slot row above and ⌃⌘←/→ / ⌃⌘T. |

**Why not plain ⌘.** R3. Bullseye is a deliberate posture change — you enter it to read or write for a while — not a verb hit many times an hour, so it has no claim on a finite plain-⌘ slot.

**Why not a composed set.** R1. ⌥⌘B or ⇧⌘B would have to read as a variant of ⌘B, and there is no ⌘B command to vary: ⌘B is **held in reserve** for bold in the free pool, because Tug renders markdown. A composed chord with no base to twist is exactly what R1 rejects.

**B is free on the tier**, and free of macOS too — the reserved ⌃⌘ set is ⌃⌘Q (lock screen), ⌃⌘D (dictionary), ⌃⌘Space (emoji), and ⌃⌘F (full screen), which the tier already hosts as its anchoring resident.

**Promotion to Window ▸ Bullseye is R6's half of the grant**, and here the preemption is the point rather than a cost: a menu item's key equivalent is claimed by AppKit before the web view sees the keydown, so no scoped binding can decline ⌃⌘B. A deck-level posture is not a surface's to refuse. The item carries an **empty** key equivalent so `applyCommandChords` writes the chord from the table and it stays rebindable — the discipline the rail pair and the Go to Slot row follow.

**Tier occupancy after this grant.** ⌃⌘ letters in use: A, B, C, F, G, H, I, K, M, P, T, U — J, L and O returned to the pool when the per-card sidebar toggles gave their chords up to the rail pair. ⌃⌘ digits: 1–3 (the card widths); 4–9 and 0 free, and free only for an *ordered set* under the digit-row rule. ⌃⌘ arrows: all four in use — ↑/↓ `move-in-column`, ←/→ the rail pair.

---

## The find-selection chord

⌘E makes the selection the find query and runs it: the find bar appears if it is not already up, seeded with the selected text and landed on the first match.

| Command | Chord | Derivation |
|---|---|---|
| `find-selection` | **⌘E** | The free pool held ⌘E for a Find-adjacent claim, and this is the claim it was held for — outside Tug, ⌘E *is* Use Selection for Find (AppKit's `NSFindPanelActionSetFindString`, and every editor that copies it). |

**Why not the ⌃⌘ tier.** Finding is a universal verb, not Tug machinery — it sits with ⌘F and ⌘G, whose family it completes.

**Why not a composed set.** R1 would want ⌘F's key, but a ⇧ or ⌥ twist of Find has to read as a *variant of opening the find bar*, and this is not one: it names what to search for. The reserved-slot convention is the stronger claim, and R1 explicitly sends a chord with no base to twist back to plain ⌘.

**R3 is satisfied by the gesture's frequency, not the command's grandeur.** Search-for-the-thing-I-am-looking-at is reached constantly while reading a transcript or a file, and the alternative is copy, ⌘F, paste — three chords for one intent.

**Promotion to Edit ▸ Find ▸ Use Selection for Find is R6's half of the grant**, alongside its three siblings. The item carries a construction-time `"e"` key equivalent, matching the rest of the Find submenu — and inheriting the same rebind debt the shade toggles are named for under Known anomalies.

**Its gate is focus-granular, not selection-granular**, and that is a consequence of R6 rather than a shortcut. A mirrored gate is computed when the menuState is pushed; dragging out a selection pushes nothing. A gate that asked "is there a selection?" would therefore still read *disabled* with the text sitting right there — and because the chord is a menu key equivalent, AppKit would eat ⌘E with a beep before the web view saw the keydown. So the item is live wherever a find surface is focused and an empty selection is a no-op at the responder, which is the answer Edit ▸ Delete already gives for the same reason.

**Not a toggle.** ⌘F summons and dismisses; ⌘E only ever seeds. A bar already up is re-seeded in place, because "search for this" can never mean "stop searching".

---

## The lateral bracket family

The bracket keys carry three commands, and they carry the same axis in all three: left and right along the deck.

| Command | Chord | Derivation |
|---|---|---|
| `previous-tab` / `next-tab` | **⇧⌘[ / ⇧⌘]** | The base pair. Moves *attention* laterally across the cards. |
| `previous-stack-card` / `next-stack-card` | **⌥⌘[ / ⌥⌘]** | R1: the ⌥-variant of the base — the same lateral motion taken through the depth of one slot's stack instead of across the deck. |
| `nudge-slot:left` / `nudge-slot:right` | **⌥⇧⌘[ / ⌥⇧⌘]** | R1 with both twists. ⇧ names the lateral axis and ⌥ alters the object: the same sideways verb, applied to the card rather than to the attention on it. |

**Why the composed set is right here.** ⌥⇧⌘ is defined as both twists at once, and a nudge is exactly that reading: it moves what ⇧⌘[/] moves *over*. A reader who knows ⇧⌘] can guess ⌥⇧⌘] without being told, which is the whole return on having an algebra.

**Why not plain ⌘[/].** The free pool reserves it for a future back/forward concept, and R3 does not override a reservation — rearranging the deck is a deliberate act, not a many-times-an-hour verb.

**⌃⌘[/] was the recorded fallback** if the R1 reading had been rejected: brackets are free on the Tug tier, and a slot is Tug's own layout vocabulary. The R1 reading held, so the fallback stays unspent.

**The composed chord reaches the web view, and that was checked rather than assumed.** ⌥⌘[/] one modifier away are menu-promoted, which raised the question of whether AppKit's key-equivalent scan would claim the ⌥⇧⌘ press too. It does not: the scan matches modifier masks exactly, so a promoted chord shadows itself and not its composed neighbours. Worth stating because the opposite was briefly believed and written down — the misreading came from a page-level `keydown` probe, which cannot see a chord the keymap already matched and consumed (`responder-chain-provider.tsx` calls `stopImmediatePropagation` on a handled match). **A probe of that shape can never distinguish "AppKit ate it" from "we handled it"; only pressing the chord and watching the deck can.**

**Unpromoted, deliberately.** The nudge acts on the *layout selection* — a fact about the Lens's Cards list, not about the frontmost card — and a mirrored `validate` is computed when the menuState is pushed, which a selection change does not push. A menu item would therefore be permanently enabled and intermittently inert.

**Refusal is a group property.** A nudge moves the whole selection or none of it; one member already against the travel edge refuses all of them, and the blocked member's border flashes. Per-member clamping would pile the selection onto the end slot — destroying the arrangement the gesture exists to preserve.

---

## The split family

A slot holds a run of vertical space, and the cards standing in it either take turns in that run or divide it. Five chords say so: one that decides which, and four that move a card within it.

| Command | Chord | Derivation |
|---|---|---|
| `toggle-column-split` | **⌃⌘S** | Tug tier: dividing a slot is Tug's own layout vocabulary, alongside the Go to Slot row, ⌃⌘B Bullseye, the ⌃⌘←/→ rail pair and ⌃⌘T Next Theme. Letter S is unoccupied on the tier — only ⌘S and ⇧⌘S exist on that key — and is the obvious mnemonic. |
| `move-in-column:up` / `:down` | **⌃⌘↑ / ⌃⌘↓** | R1's base pair on the vertical axis, in the tier that owns the slot. Arrows are R1-exempt under R2. |
| `move-in-column:top` / `:bottom` | **⌃⇧⌘↑ / ⌃⇧⌘↓** | The counterpart set of the ⌃⌘ base: top and bottom are the ⇧-extreme of up and down, exactly the shape ⌥⇧⌘↑/↓ First/Last Turn has one tier over. |

**Why ⌃⌘ arrows are available.** The macOS never-bind list reserves *plain* ⌃-arrows for Spaces and Mission Control — not the ⌘ composition. The vertical pair was unbound in Tug when this family took it, and the horizontal pair was still unbound when the rail promotion took that; all four are spent now, and the tier's arrows are a closed set. Checked against the registry rather than assumed in both cases, and pinned by the routing-drift guard, which fails on any chord the table gains without being declared.

**The arrows are never dead on an unsplit slot,** and that is why they mean two things. Split, the members divide the run and up is up: the chord moves a member's place in the order and the frames swap pins. Stacked, nothing is above anything — every member draws the same rect — so the only ordering the eye can read is z, and up is toward the front. One chord, one meaning per arrangement. A chord that worked only after another chord had been pressed would be a chord the user has to remember the state of.

**Promoted to the Window menu**, unlike the nudge pair and ⌘1–9. The objection that kept the family off it was real: it acts on the *layout selection*, a fact about the Lens's Cards list rather than about the frontmost card, so a mirrored `validate` had nothing to read that would tell a live gesture from a dead one. That was answerable, and the answer costs a fact. `menu.column` resolves the **same ladder the handlers walk** — the selection, else the row the Cards list's cursor stands on, else the first responder — so an item is live exactly when its chord would act. The two inputs that move without a deck mutation, the selection store and the cursor, each push a menu-state flush; a fact that went stale on either would dim a live item, and a dimmed item's key equivalent is swallowed by AppKit before the web view sees it, which would take the chord down with it.

That last sentence is the whole cost of a promotion and it applies to this family too: ⌃⌘S and the ⌃⌘ arrows now leave the JS funnel and are claimed globally by the menu bar, above every surface — including a text editor's caret. `disabledChord: "keep"`, as the Go to Slot row does: nothing else in the funnel wants these chords, so there is nothing for a detach to hand them back to.

**Refusal is visible.** ⌃⌘S on a slot holding one card has nothing to divide, and a member already at the end it was sent to has nowhere to go; both flash the pane's border rather than returning quietly. A chord that does nothing and says nothing cannot be told from a chord that never arrived.
