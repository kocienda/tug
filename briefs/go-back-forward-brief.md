# Go ▸ Back / Forward: step through the cards you had focused

**Purpose:** The Go menu can move focus by position (the lateral ring, the stack, the four directions, the slots) but not by time. The user wants to return to the card they were on before this one, and to retrace forward, wherever that card is.

---

## Purpose {#purpose}

The request, in the user's words:

> Give me a new command for the Go menu. I want to go to the previous/next card *I had focused*, even if this is in a different workspace.

The chord was asked for as `⌃⌥⌥[` and `⌃⌥⌥]`, read as **⌃⌥⌘[ / ⌃⌥⌘]** since ⌥ appears twice. The user confirmed that reading and confirmed the exception to the chord doctrine it requires: "confirmed. make the exception."

---

## Evidence {#evidence}

**[F01] The Go menu has no verb that moves by time.** `tugapp/Sources/MenuBarBuilder.swift` (the `gMenu` block, from line 618) builds four groups: Previous / Next Card and Previous / Next Card in Stack with Reveal Stack, Focus Card Left / Right / Above / Below, Go to Slot 1…6, and the four turn verbs. Every one is relative to position or to the transcript. **(verified)**

**[F02] The deck already records every activation, in a shape that cannot go forward.** `_activationHistory` in `tugdeck/src/deck-manager.ts` (line 979) is a most-recent-first list holding each card id once, capped at `ACTIVATION_HISTORY_LIMIT = 64`. `_noteActivation` moves an id to the front, and `_flipFirstResponder` (line 4974) calls it on every activation. Its readers are the close-successor rule (`_closeSuccessorCardId`, `lib/close-successor.ts`) and one stack-splice path at line 7036. A move-to-front list has no cursor and loses the order of repeat visits, so it can answer "which card was I last in" and cannot answer "forward". **(verified)**

**[F03] That history is deck-wide, not per workspace.** There is one `_activationHistory` on the manager, and its doc comment says ids of cards that no longer stand are not pruned: the reader filters. `activateSpace` (line 1382) swaps the deck without clearing it, and its step (8) calls `_noteActivation(focus)` for the arriving workspace's focus. So ids of cards in parked workspaces survive a switch. **(verified)**

**[F04] Nothing maps a card id to the workspace that holds it.** A search of `deck-manager.ts` and `tugdeck/src/lib/` for such a lookup found none. `activateSpace` takes a space id, finds the parked record through `spacesStore.find`, and requires its `deck` to be non-null. A parked record's `deck` is where a lookup would read. **(verified by search; the shape of a parked deck record was not read)**

**[F05] A workspace switch lands on the workspace's own remembered focus.** Step (8) of `activateSpace` activates the arriving workspace's `focus`, either as part of the swap or by `activateCard(focus)` afterwards. There is no parameter naming a different card to arrive on. **(verified for step (8); the rest of the function was not read)**

**[F06] Five of the bracket row's chord sets are spent, and plain ⌘[/] cannot be used.** `tuglaws/chord-tiers.md`: ⇧⌘[/] the lateral card ring, ⌥⌘[/] the stack ring, ⌥⇧⌘[/] the slot nudge, ⌃⌘[/] Previous / Next Turn, ⌃⇧⌘[/] First / Last Turn. Plain ⌘[/] is "reserved for any future back/forward navigation concept", which this is, but CodeMirror's `defaultKeymap` binds `Mod-[` / `Mod-]` to `indentLess` / `indentMore` in the composer and the text card, so a promoted ⌘[ would kill dedent and a scoped one would be dead in the composer. ⌃⌥⌘[/] is the only ⌘-bearing three-modifier set left on the row. **(verified)**

**[F07] The doctrine closes ⌃⌥⌘ to new grants.** `tuglaws/chord-tiers.md`, section *⌃⌥⌘ is spoken for outside Tug*: "No new chord may be granted on ⌃⌥⌘", with one grandfathered resident, ⌃⌥⌘P Cycle Permission Mode, and "A second would not be granted." The reason given is Keyboard Maestro's machine-wide hot keys on the set, which swallowed ⌃⌥⌘R and ⌃⌥⌘S before Tug's menu bar saw them. **(verified)**

**[F08] Keyboard Maestro holds neither bracket key.** Read on 2026-11-16 from `~/Library/Application Support/Keyboard Maestro/Keyboard Maestro Macros.plist` with `plutil -p`: 18 hot keys carry `Modifiers 6400` (⌃⌥⌘), and no hot key in any modifier set is on KeyCode 33 (`[`) or KeyCode 30 (`]`). So ⌃⌥⌘[ and ⌃⌥⌘] reach Tug today. **(verified; it is a reading of the plist on one day, and a macro added later would change it)**

**[F09] ⌃⌥ without ⌘ is not a usable set.** `tuglaws/chord-tiers.md` records Cascade ⌃⌥C and Tile ⌃⌥T as a resolved anomaly: "⌃⌥ with no ⌘, a set the algebra does not generate, invisible to the keymap pane." **(verified)**

**[F10] The neighbouring families show the wiring to copy.** The turn verbs and the directional-focus verbs are built in `MenuBarBuilder.swift` with empty key equivalents, so `applyCommandChords` writes the chord from the frontend keymap and the binding stays rebindable. Each row is gated by its registry entry on the menuState push. A dark directional row keeps its chord (`disabledChord: "keep"`), and the press reaches the web view, where it is answered with a border flash. The registry entries are in `tugdeck/src/components/tugways/command-registry.ts` and the action names in `tugdeck/src/lib/action-vocabulary.ts`. **(verified in the Swift comments and by locating the registry entries; the registry entries themselves were not read)**

---

## Decisions {#decisions}

**[B01] The Go menu gains Back and Forward.** Back moves focus to the card the user was on before the current one. Forward retraces a Back. The titles are "Back" and "Forward" because "Previous Card" and "Next Card" already name the lateral ring, and Back / Forward says the order is time, not position. They are the first group in the Go menu, which is where Finder puts them. Actions are `go-back` and `go-forward`; menu identifiers are `go.back` and `go.forward`.

**[B02] The chords are ⌃⌥⌘[ and ⌃⌥⌘], granted as an exception to the ⌃⌥⌘ closure.** The user confirmed both the chord and the exception. The grant rests on [F06] and [F08]: it is the only seat left on the row whose every other family reads `[` as back and `]` as forward, and the outside claimant leaves both keys alone. The hand forms it: three left-hand bottom-row modifiers and a right-hand bracket.

**[B03] `tuglaws/chord-tiers.md` is amended in the open, in the same arc.** The section *⌃⌥⌘ is spoken for outside Tug* stops saying a second resident would not be granted and records this pair as granted by exception, with the plist reading of [F08] and its date as the evidence. The rule that survives is narrower and still true: a ⌃⌥⌘ grant is made only on a key checked against the plist, never assumed. The tier table row, the bracket-row passage ("five families" becomes six) and the plain-⌘[/] reservation row are updated to match, and the reservation row says where the back/forward concept landed and why it could not land on ⌘[/]. If the doctrine's decision log needs a new `[D###]` entry for the exception, the arc adds it.

**[B04] Back / Forward runs on a new focus trail, separate from `_activationHistory`.** [F02] is why: the existing list is the right shape for close-successor and the wrong one here, and reshaping it would move the mechanism under a settled decision. The trail is a pure module (suggested `tugdeck/src/lib/focus-trail.ts`) holding an ordered list of visits and a cursor, with browser semantics:

- a landing appends a visit, and a landing made while the cursor is behind the end drops everything ahead of the cursor first;
- a Back or Forward step moves the cursor and records no visit;
- a landing on the card the cursor is already on records nothing;
- the trail is capped at 64 visits, dropping the oldest.

It is written from `_flipFirstResponder`, beside `_noteActivation`, since every activation passes through there.

**[B05] A card that no longer stands is skipped and pruned.** A step that meets a closed card removes it from the trail and continues in the same direction. A step with nothing left in its direction is a refusal.

**[B06] A step crosses workspaces, and arrives on the target card directly.** When the target is in a parked workspace, the step activates that workspace and lands focus on the target. This needs the lookup [F04] says is missing, and it needs the switch to arrive on a named card and not on the workspace's remembered focus ([F05]). Arriving on the remembered focus and then hopping would show two focus moves and would write an intermediate visit that the user never made. The arrival of a step records no visit, the same as a step within one workspace.

**[B07] Every landing counts.** Cards passed through with ⇧⌘] or a directional chord are visits, as is the focus a workspace switch arrives on, and sidebar cards count like any other. A dwell threshold was the alternative; it needs a timer and makes "where does Back go" depend on how fast the user moved.

**[B08] The trail lives in memory.** It starts empty at launch and is not persisted. A trail of card ids from a previous launch would point at cards whose state has moved under it, and nothing in the request asks for it.

**[B09] The wiring follows the turn and directional-focus families.** Registry entries are `menuEligible` at global scope. The Swift rows carry empty key equivalents so `applyCommandChords` writes the chords and they stay rebindable. Each row is gated on whether the trail has anything behind or ahead of the cursor. A dark row keeps its chord, and a press on it is answered with the border flash on the focused pane.

**[B10] Verification is a unit suite over the trail and one app-test for the crossing.** The trail's rules in [B04] and [B05] are pure and are tested as such: truncation on a new landing, skip and prune of a closed card, the cap, the no-op on a repeat landing. One app-test covers a Back step that crosses into a parked workspace and lands on the right card, and it carries `@covers` for the files it exercises.

---

## Open Questions {#open-questions}

- **How the switch is told which card to arrive on.** [B06] fixes the behaviour; the mechanism depends on parts of `activateSpace` not read for this brief (steps 2 to 7, and how `focus` and `focusInSwap` are derived). Reading that function settles it.

---

## Non-goals {#non-goals}

- **Reshaping `_activationHistory`.** It serves close-successor and stays as it is ([B04]).
- **Plain ⌘[ / ⌘].** Reserved for this concept and unusable for it: CodeMirror's dedent and indent hold the pair in the composer and the text card ([F06]).
- **⌃⌥[ / ⌃⌥] with no ⌘.** A set the algebra does not generate and the keymap pane cannot see ([F09]).
- **A dwell threshold or any other filter on which landings count.** Rejected in [B07].
- **Persisting the trail across launches.** Rejected in [B08].
- **A visible history list or picker.** The request is two stepping verbs. A menu of recent cards is a different feature.
- **Reopening closed cards.** Back skips a closed card; it does not bring it back.

---

## Exit {#exit}

**An arc.** The raw material for its steps, in an order that keeps each one testable:

- The pure trail module and its unit suite ([B04], [B05]).
- The trail written from `_flipFirstResponder`, with steps suppressed from recording, and `go-back` / `go-forward` working inside one workspace.
- The card-to-workspace lookup and the arrive-on-a-named-card switch, then the crossing step ([B06]), which first needs the open question answered.
- The action names, registry entries, gates and refusal flash, and the two Swift rows at the top of the Go menu ([B01], [B09]). The Swift change needs `just app-test-build` before any app-test reads it.
- The `tuglaws/chord-tiers.md` amendment ([B03]), with whatever chord-table or routing-drift pin the new grant moves.
- The crossing app-test ([B10]).
