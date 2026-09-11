# Fold / Unfold: the name for what a Session card does when it shrinks to its instruments

**Purpose:** The feature landed under [D185] is called *minimize* everywhere — menu, control, action, pane field, CSS attribute, tests, laws — and the word is wrong. Rename it Fold / Unfold, with *folded* as the state, in one comprehensive pass with no compatibility residue.

---

## Purpose {#purpose}

In the user's words:

> We can't really call this feature *minimizing* a session. What could call this? Full|Mini View? Views as Transcript|Bar? What do you think?

Settled in conversation: **Fold / Unfold**, state **folded**. The other candidates were weighed and set aside (see Non-goals). This brief is the roll-out: where the old word lives, what the new one replaces, and what is deliberately left alone.

---

## Evidence {#evidence}

**[F01] "Minimize" describes a different gesture.** On macOS, minimize means the window leaves the screen for the Dock. A folded Session card stays on the wall, keeps its masthead beat, its five Z2 instruments and its control, and keeps reporting. The arc commit `148f8a5ca` describes the shape as "a run of sessions being watched rather than talked to, each readable without being opened" — the opposite of gone. The word also collides with ⌘M, which is why the card's chord had to become ⌥⌘M. **(verified, from the commit message and the Window menu)**

**[F02] The code already speaks "fold" wherever it describes the motion.** `session-card.tsx` writes `data-fold` (`settled`, mid-fold), keeps `foldRef` / `foldEndRef` / `lastFoldRef`, and its comments say "the fold", "the unfold", "pre-fold", "fold-then-slide". `deck-manager.ts` has `panesWithWallFolded`. [D185]'s own headline says "a fold that runs on the deck's own settle clock", and its body says the interior "folds rather than unmounts ([L26])". `briefs/session-minimize-reveal-brief.md` is written entirely in fold / unfold / reveal. The word arrived on its own; only the *name* of the feature never caught up. A `grep -o` over the card, its CSS, the control and `deck-manager.ts` counts 39 `fold`, 12 `folded`, 11 `data-fold` today. **(verified)**

**[F03] The old word has one surface and roughly a dozen identifiers.** `grep -i minimiz` across `tugdeck/src`, `tugapp/Sources`, `tests/app-test` and `tuglaws` touches about 60 files. The distinct identifiers, by count:

| Identifier | Kind | Where |
|---|---|---|
| `toggle-session-minimized` / `TOGGLE_SESSION_MINIMIZED` | action | `action-vocabulary.ts`, `command-registry.ts`, `AppDelegate.swift`, `session-card.css` comments, tests |
| `set-card-minimized` / `SET_CARD_MINIMIZED` | setter action | `action-vocabulary.ts`, `command-registry.ts` ("Set Card Minimized") |
| `session.minimize` | menu item id | `command-registry.ts`, `AppDelegate.swift`, `host-menu-state.ts`, `menus.md`, tests |
| `TugPaneState.minimized?` | persisted pane field | `layout-tree.ts`, `serialization.ts`, `deck-manager.ts` |
| `data-minimized` | frame attribute | `tug-pane.tsx`, every CSS rule keyed on the form |
| `paneMinimizedOf` / `cardMinimizedOf` / `panesWithMinimized` | selectors | `deck-store-selectors.ts`, `deck-manager.ts` |
| `setPaneMinimized` / `setCardMinimized` / `toggleMinimized` / `setMinimized` | deck-manager verbs | `deck-manager.ts`, `action-dispatch.ts` |
| `registerMinimizable` / `getMinimizedSizePolicy` / `minimizedSizePolicy` / `minimizedState` / `frameMinimized` | card-registry contract | `card-registry.ts`, `session-card-registration.tsx`, `deck-canvas.tsx`, `layout-imposer.ts` |
| `SESSION_MINIMIZED_HEIGHT_PX` / `MASTHEAD_MINIMIZED_HEIGHT` | tier constants | `session-card-registration.tsx`, `tug-pane.tsx` |
| `SessionMinimizeControl` / `session-minimize-control.{tsx,css}` / `.session-card-minimize-control` | the control | `cards/` |
| `minimized: boolean` | test-surface `getPaneRecord` field (`2.17.0`) and `host-menu-state` session record | `test-surface.ts`, `host-menu-state.ts` |
| `toggleSessionMenuMinimized` / `"Minimize Session"` / `session.minimize` | AppKit menu item | `AppDelegate.swift:1174–1180`, `:1883–1887` |

**(verified by grep; counts are as of 2026-09-11)**

**[F04] The user-facing strings are three.** The Session menu row and the section-menu row read `Minimize Session`, flipping to `Show Transcript` when folded (`command-registry.ts:1741–1757`, `host-menu-state.ts:450`). The control's tooltip and `aria-label` read `Minimize` / `Show Transcript` (`session-minimize-control.tsx:76`). The Show Transcript *bar* is gone ([D185]: "it retired when the control took the Z2 seat"); only the label survives. **(verified)**

**[F05] Two "minimize" families in the tree belong to the window and must not move.** `TUG_ACTIONS.MINIMIZE` / `window.minimize` / ⌘M is AppKit's own `performMiniaturize` (`AppDelegate.swift:1251`, `menus.md:223`, `:374`), and `windowMinimize` in `deck-manager.ts` is its deck-side echo. `action-naming.md:85` lists bare `minimize` among the single-word responder verbs, and `:245` maps it. `TestHarnessListener.swift:117` and `framework-architecture.md:7` use the ordinary English word. The `window-sidebar-brief.md` rejection of the diamond glyph is about minimized *windows*. None of these are the card feature. **(verified)**

**[F06] The persisted key has no installs behind it.** `serialization.ts:566–582` reads `win["minimized"] === true` off the deck blob and rebuilds the pane with it. Per the standing premise ([[no-installs-in-the-wild]], 2026-09-03), there is no deck blob outside this checkout carrying the key, so the field can be renamed as a clean break with no reader for the old spelling. **(verified in code; premise is the user's, recorded 2026-09-03)**

**[F07] Seven app-tests and one unit test carry the word in their filenames.** `at0550-session-minimize-doors` through `at0557-session-minimize-shapes` (no `at0556`), plus `tugdeck/src/__tests__/pane-minimized.test.ts`. Their `@covers` lines name `session-minimize-control.tsx` and `.css`, so a file rename of the control must be mirrored there or `just app-test-covers-check` fails. `select-tests.ts:253` records at0551 by number and describes it as "the minimized Session card's form", a comment only. **(verified)**

**[F08] The chord's recorded derivation depends on the old verb.** `chord-tiers.md:31` defines the ⌥ tier as "same verb, altered object or form" and gives "⌘M Minimize → ⌥⌘M Minimize Session" as an instance. Once the card's verb is Fold, the line as written no longer holds. The obvious alternative key is spoken for: ⌘F is Find and `chord-tiers.md:291` rules that a ⌥ twist of F "has to read as a variant of opening the find bar". ⌃⌘F is Full Screen. ⌃⌥⌘ is reserved ([[ctrl-alt-cmd-reserved]]). **(verified)**

**[F09] Doctrine mentions are concentrated in three law files and one open brief.** `design-decisions.md` (D185 body, the [D97] Z2 diagram at `:302`, `:325`, `:333`), `menus.md:240` and `:332`, `chord-tiers.md:31`; and `briefs/session-narration-consolidation-brief.md` at four places ([F10], the inventory, [B08], the exit), which is live work and will be read by whoever walks it. The untracked spike `spike-light-tint.tsx:403–525` uses `session-minimize` as fixture row text. **(verified)**

---

## Decisions {#decisions}

**[B01] The feature is Fold / Unfold, and the state is folded.** The verb names the motion truthfully, carries no window-management meaning, and is the word the code, the design decision and the reveal brief already reach for unprompted ([F02]). "Folded" as the adjective reads as a first-class form rather than a diminished one, which is what a wall of watched sessions is. Revisit only if the form stops being a fold — if, say, the card were ever to leave the wall.

**[B02] The rename is total on the card feature and touches nothing that belongs to the window.** Every identifier in [F03] takes the new word: `toggle-session-fold` and `set-card-folded` for the actions, `session.fold` for the menu id, `TugPaneState.folded?`, `data-folded`, `paneFoldedOf` / `cardFoldedOf` / `panesWithFolded`, `setPaneFolded` / `setCardFolded`, `registerFoldable` / `getFoldedSizePolicy` / `foldedState` / `frameFolded`, `SESSION_FOLDED_HEIGHT_PX` / `MASTHEAD_FOLDED_HEIGHT`, `SessionFoldControl` in `session-fold-control.{tsx,css}` with `.session-card-fold-control`, and `folded: boolean` on the test surface and the host menu record. The families in [F05] stay exactly as they are. Exact spellings are the implementer's to settle against the naming law; what is decided is that no `minimiz*` identifier remains on the card feature, so a final `grep -i minimiz` over `tugdeck/src`, `tugapp/Sources` and `tests/app-test` returns only the window's own entries.

**[B03] User-facing copy is `Fold Session` / `Unfold Session` on the menus and `Fold` / `Unfold` on the control.** Both are one verb pair, so the dynamic title in `command-registry.ts` and `host-menu-state.ts` and the control's tooltip and `aria-label` flip between the two halves of the same word. `Show Transcript` retires as a label: it named the bar that no longer exists ([F04]), and it names one of three things that unfold. Whoever wants to know what unfolding reveals can see it.

**[B04] The persisted pane key becomes `folded` with no reader for `minimized`.** Per [F06] there is nothing to migrate and no bridge to keep. `serialization.ts` honours only `folded === true`; an old blob with `minimized` restores open, which is the same thing the field's "absent means not" rule already does. This is the [[no-installs-in-the-wild]] premise applied; it stops applying the day there is an install.

**[B05] The chord stays ⌥⌘M, and the derivation is rewritten rather than the key.** [F08] closes every F-shaped door, and ⌥⌘M has already been learned by the one user there is. The `chord-tiers.md` line changes from "same verb" to the true relation: ⌘M puts the window away and keeps it; ⌥⌘M puts the card's body away and keeps it — the same *form* of gesture on a smaller object, which is the tier's own definition of a variant. `menus.md:240` reads `⌥⌘M | toggle-session-fold | Fold Session`. Revisit if a free letter in the ⌥⌘ set is ever wanted for a chord whose base really is the same verb.

**[B06] Test files are renamed with the feature, and `@covers` moves with them.** `at0550–at0557-session-fold-*.test.ts` and `pane-folded.test.ts`. The numbers do not change, so `select-tests.ts:253`'s reference to at0551 stays true with one word of comment edited. The control's file rename must be mirrored in the `@covers` lines of at0550 and at0551 ([F07]) or the covers check fails.

**[B07] Doctrine is edited to read as if the feature had always been called this.** D185's headline becomes "A Session card folds to a masthead and its status row", and its body, the [D97] diagram and its two zone paragraphs, `menus.md` and `chord-tiers.md` take the new word throughout. Git history is not rewritten and commit messages keep their titles; a reader who meets `tugarc(session-minimize)` in the log meets D185, which now says the word changed. The open `session-narration-consolidation-brief.md` gets the same four-word edit so it does not hand the next arc the old vocabulary. The `session-minimize-reveal-brief.md` keeps its filename: it is already written in fold language and renaming a brief that is about to be walked buys nothing.

**[B08] The comment corpus is swept, not just the identifiers.** [F03] counts 302 bare `minimized` and 108 `minimize`, and most are prose in comments and CSS headers ("a wall of minimized cards", "the minimized tier"). A rename that leaves the comments saying the old word gives every future reader two names for one thing, which is exactly the fault this brief exists to remove. The sweep ends with the grep in [B02] reading clean.

---

## Open Questions {#open-questions}

None that change what is written. The one judgment call taken here is [B05], the chord; it is recorded with its reasoning so it can be overruled in a sentence rather than re-argued.

---

## Non-goals {#non-goals}

- **Full | Mini View.** Rejected: names size rather than purpose, "Full" reads the folded card as a degraded version of the same thing, and "mini" is an Apple product-line word.
- **Transcript | Bar.** Rejected: the folded form is three rows and not a bar, and "Transcript" names one of the three things that fold away, leaving the composer and the find bar unnamed.
- **Watch / Read.** Considered as the reader's stance, which is the real distinction. Rejected as the *name* because "Watch Session" reads as starting something; it remains the right way to explain the wall in prose.
- **Tile as a noun for the folded form.** Considered; a wall of tiles is literal. Set aside because it adds a third noun beside card and pane, and Fold already gives the state a name. Not ruled out for later.
- **Collapse / Expand and Compact / Full.** Serviceable and generic; each loses the fact that the folded form is a first-class thing.
- **Strip.** Ruled out: the column already uses the word for its overflow strip.
- **Renaming the window's minimize.** ⌘M, `window.minimize`, `TUG_ACTIONS.MINIMIZE`, `windowMinimize` and the `action-naming.md` single-word verb are AppKit's gesture under AppKit's name ([F05]).
- **A compatibility reader for the old `minimized` blob key.** Nothing to read it for ([F06]); a bridge here would be the first of the kind the [[no-installs-in-the-wild]] premise exists to refuse.
- **Rewriting git history or the reveal brief's filename.** History stands; the reveal brief is already in the new language.
- **Renaming `data-fold`, `foldRef` and the rest of [F02].** Those are already right and are the target the rest converges on.

---

## Exit {#exit}

An arc, in one landing. The order that matters is only that the mechanical rename goes before the prose sweep, so the sweep is checked against a tree that already compiles:

1. Identifiers and files ([B02], [B06]): actions, selectors, deck-manager verbs, card-registry contract, constants, the control's files and class, the pane field and `serialization.ts` ([B04]), the test surface and host-menu record, the Swift menu item, the test file renames and their `@covers`. `just lint`, `just app-test-covers-check`, the tugdeck unit tests, and `just app-test-changed` green.
2. Copy ([B03]): the menu titles, the control's label, and the app-tests that assert them.
3. Doctrine and chord ([B05], [B07]): D185, the [D97] diagram, `menus.md`, `chord-tiers.md`, the narration brief.
4. The comment sweep ([B08]), closed by `grep -ri minimiz` over `tugdeck/src tugapp/Sources tests/app-test tuglaws` returning only the window's entries.
