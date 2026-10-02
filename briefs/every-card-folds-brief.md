# Every content card folds: the Session card's fold, generalized to the pane

**Purpose:** Only a Session card folds. A Text card — and every other content card — has no folded form, no door onto one, and no tier to stand at, so a column of watched cards can hold sessions and nothing else. Every content card must fold to its masthead and a small, representative slit of its own content, at the height a folded Session card stands at.

---

## Purpose {#purpose}

In the user's words:

> Text file cards don't fold/unfold like session cards do. In fact, *all* content cards must be able to fold to their titlebar/mastheads and a representatively-small amount of content that matches the height of a session card.

[D185] built the fold for the Session card and built most of it at the pane. What reached the user is a feature only one card type can use: with a Text card as the key card the menu item is disabled and ⌃⌘Y beeps. The wall [D185] exists for — a split column of cards each readable without being opened — cannot hold a file.

---

## Evidence {#evidence}

**[F01] The folded fact and its one writer are already pane-generic.** `TugPaneState.folded?` is a pane field; `setPaneFolded` (`tugdeck/src/deck-manager.ts:7900`) refuses only a pane hosting a sidebar card ("rails do not fold") and otherwise writes the flag for any pane. `setCardFolded` resolves a card to its pane, and `SET_CARD_FOLDED` is registered in `tugdeck/src/action-dispatch.ts:763` with a `{ cardId, folded }` payload and no card-type check. `paneFoldedOf` / `cardFoldedOf` (`deck-store-selectors.ts:177`, `:186`) read it for any card. **(verified)**

**[F02] The packing is generic.** A folded column member takes its stack's folded policy as both floor and ceiling and weighs zero (`deck-store-selectors.ts:673–690`); `panesWithWallFolded` (`deck-manager.ts:900`) folds the siblings of a card opened in a wall by pane membership alone; the folded flag is a term of `arrangementSignature` (`deck-canvas.tsx:730`). None of it names a card type. **(verified)**

**[F03] The motion's hold is generic by its own statement.** `tug-pane.css` holds the card root at `--tugx-still-held-height` for the crossing through `.tug-pane[data-still-crossing] .tug-pane-content [data-card-host] > *`, with the comment "for every card type and with no opt-in", and names CodeMirror's host among the subtrees it protects. `.tug-pane[data-folded="true"] .tug-pane-content { overflow: hidden }` (`tug-pane.css:1726`) clips any folded pane's content box at rest. `markFoldCrossing` / `endFoldCrossing` (`lib/fold-crossing.ts`) are driven by the imposer off the frame's `data-folded`, not by the card. **(verified)**

**[F04] The door is Session-only.** `TOGGLE_SESSION_FOLD` is answered by the responder inside `SessionCardBody` (`session-card.tsx:4438`), which reads `cardFoldedOf` and dispatches `SET_CARD_FOLDED`. Its registry entry (`command-registry.ts:1903`) is `routing: "key-card"`, `validate: sessionBound`, `menuItemId: "session.fold"`, titled "Fold Session" / "Unfold Session" from `chain.menu.session?.folded`; the native item is built in the Session menu (`tugapp/Sources/AppDelegate.swift:1339`) and sends `toggle-session-fold` (`:2085`). The registry comment says a non-Session key card "disables the item and beeps the chord". **(verified)**

**[F05] The tier is Session-only.** `foldedSizePolicy` is declared by `session-card-registration.tsx:158` alone, pinned to `SESSION_FOLDED_HEIGHT_PX = 145`. `getFoldedSizePolicy` (`card-registry.ts:517`) falls back to a card's ordinary `sizePolicy` when none is declared, and the Text and file-view registrations declare `min.height: 400`. So writing `folded: true` onto a Text card's pane today would mark the frame and leave it at least 400px tall. That last sentence is read from the code, not run. **(verified by reading; not reproduced)**

**[F06] The form is Session-only.** The control is `SessionFoldControl`, seated in Z2; the folded layout is `.session-card[data-fold=…]` and `.tug-pane[data-folded="true"] .session-card …` rules in `session-card.css:1543–1629`; `inert` and `data-fold="moving" | "settled"` are written by an effect in `session-card.tsx` (~`:2664–2756`) listening for `FOLD_CROSSING_END`. No other card has any rule keyed on `data-folded`. **(verified)**

**[F07] The two masthead tiers differ by one line, so the band under a document masthead is 73px.** `MASTHEAD_HEIGHT = 72` and `SESSION_MASTHEAD_HEIGHT = 88` (`tug-pane.tsx:188`, `:209`), selected by `data-masthead-kind` (`"session"` | `"card"`). The folded tier of 145 is the Session masthead plus its Z2 row ([D185]). Under a 72px document masthead the same tier leaves 73px. Cards with no masthead (About, Settings, Keyboard) wear a shorter title bar and would leave more; that figure was not read. **(72/88/145 verified; the non-masthead remainder not measured)**

**[F08] A Text card's body is editor, optional asset strip, optional find bar, status strip, in one column.** `text-card.tsx:1243–1330`: `TugTextCardEditor`, then `TugAttachmentPreview` when the document has attachments, then `TextCardFindBar` when open, then `TextCardStatusBar`, then the sheet and one `TugPaneBanner` for disk conflicts. The status strip is `min-height: 2rem` plus a 1px rule (`text-card.css:76`) and carries line ending, syntax, caret position and counts; the save state already moved off it to the document masthead (`text-card-status-bar.tsx` header). **(verified)**

**[F09] The bidden-surface gesture is already card-agnostic.** `unfoldCardForBiddenSurface(cardId)` and `useIsCardFolded(cardId)` (`lib/card-fold.ts`) take any card id and go through `SET_CARD_FOLDED`. **(verified)**

**[F10] The title bar already has a slot for card verbs, and it is revealed on hover.** `pane-model.md` (the "Every verb in the rollup is a glyph" paragraph) records `PaneTitleBarItem` as a ghost icon button and says "the row itself is already revealed on hover"; it also records that a Fold row once lived there behind a `⋮` overflow that was cut. The rollup's code was **not read** for this brief — how a masthead-wearing pane seats it, and whether one item can be pinned visible while its siblings stay hover-revealed, is unestablished.

**[F11] [D185] left two things open that this work touches.** "Not done, deliberately: a folded pane whose active tab switches to a non-Session card keeps the form (nothing hides it for that tab); and a View ▸ menu row for the focused pane's folded state." And, still open: an unbound Session card has no Z2 and "today it folds to a blank box". **(verified, `tuglaws/design-decisions.md` [D185])**

---

## Decisions {#decisions}

**[B01] Every non-rail card folds, and they all stand at one tier.** `SESSION_FOLDED_HEIGHT_PX` becomes a shared folded-card height (145), and `getFoldedSizePolicy` returns a height-pinned policy at that tier for every card type that does not declare its own, instead of falling back to the open policy ([F05]). The user's requirement is the argument: the folded content "matches the height of a session card", so a wall of sessions and files packs on one row height and nothing ripples when a neighbour is a different kind. Rails stay excluded, as `setPaneFolded` already has it ([F01]). The band is whatever the chrome leaves under the tier — 73px under a document masthead ([F07]).

**[B02] The folded content is the card's own body, clipped — not a second rendering.** Under `data-folded` the card root fills the band, top-anchored, `inert`, with the pane's existing clip ([F03]) cutting it. Nothing unmounts ([L26]), so a Text card's autosave and disk sync keep running and its scroll position survives. It is the default for every card type with no per-card work, which is what makes "all content cards" true on the day it lands; a card whose top slice reads badly (an image, a PDF page) can author a better slit later without changing the rule.

**[B03] The slit shows where the reader was.** A Text card's editor keeps its `scrollTop` across the fold, so the band shows the top lines of the viewport the reader left and the unfold lands in place. Head-of-file was the alternative and is rejected: it is steadier, and it is most often a licence block or imports.

**[B04] A Text card's status strip is out of layout while folded.** Its cells are editing tools — line ending, syntax, caret, counts ([F08]) — not facts a reader who will not open the card wants, and at 33px it would leave room for two lines where the band holds about three and a half. The asset strip and the find bar leave with it, by the same reading: the band is the document's text.

**[B05] One command, hoisted to the pane: `toggle-card-fold`.** `TOGGLE_SESSION_FOLD` is renamed and answered at the pane or deck level for any content key card rather than inside `SessionCardBody` ([F04]); its gate becomes "the key card is a content card" rather than `sessionBound`. It keeps ⌃⌘Y — the glyph reading in `chord-tiers.md` is about a fold, not about a session. The native item becomes **Fold Card** / **Unfold Card** and moves from the Session menu to View, where [D185] already said a row for the focused pane's folded state belonged ([F11]) and where it is live over a file. The install base is zero, so the action id and the menu item id are renamed cleanly with no alias.

**[B06] The control on a non-session card is a pane-owned ghost glyph on the title bar, pinned visible while folded.** The user's call was "let's try it". The title bar or masthead is the only chrome every content card has, so this is one implementation for every card type rather than a seat authored per card; the alternative — the trailing edge of the Text card's status strip, mirroring Z2 — was set aside because [B04] removes that strip from the folded form and most cards have no strip at all. Same glyph pair as the Session control (`ChevronsDownUp` / `ChevronsUpDown`), same command ([B05]). Pinned while folded because a hover-revealed door ([F10]) is no door on a card whose only gesture is to open.

**[B07] The folded card's control is its key view, and Return unfolds.** With the body `inert` ([B02]) the control is the one live stop a folded non-session card offers, so it takes the role [D185] gave the Session control: the card's Return-home. The unfold returns focus to the card's own content (for a Text card, the editor, through the `onCardActivated` path its `engineKind: "em"` already uses).

**[B08] The Session card keeps its form and its seat.** Its Z2 band, `SessionFoldControl` at Z2's trailing edge, the `data-fold` effect, the bottom-anchored transcript hold and the wall register are [D185]'s settled ink and are not re-opened here. It gains nothing from [B06]: one verb, one seat per card, and the Session card already has its seat. Its tests stand as pins and change only for the rename in [B05] — a test re-pointed to agree with this work would be burying [D185], not extending it.

**[B09] A surface the user asks for unfolds the card first.** Find, the save sheets, and any other bidden surface on a folded Text card go through `unfoldCardForBiddenSurface` ([F09]) and then present where they do on an open card — the folded-card brief's [B02], applied unchanged to a second card type.

**[B10] An unbidden disk conflict on a folded Text card is said on the masthead, and the banner waits for the unfold.** The conflict banner seats over a body that is 73px tall and `inert`; raising it there is the Session card's sheet-over-a-folded-frame defect again. The document masthead already carries the save state ([F08]), so that line carries the conflict while the card is folded, and the banner presents when the card opens — deferring without spending, the way [D185] has the Changes room defer.

---

## Open Questions {#open-questions}

- **Does the title-bar seat hold up in the hand?** [B06] is a call to try, on code this brief did not read ([F10]). What settles it is building it: whether a pinned glyph sits honestly in a masthead tier, whether it reads as the same control as the Session card's Z2 one when the two stand in one wall, and whether a pane with tabs gives it a place. If it does not hold, the fallback is a seat inside the band's trailing edge, and that is the user's call on seeing it.
- **What does a mixed-tab pane do?** The flag is the pane's ([F01]) and [D185] left "a folded pane whose active tab switches to a non-Session card keeps the form" as not done ([F11]). Once every card has a folded form that note mostly dissolves — the pane stays folded and the active tab shows its own slit — but a pane holding a Session tab and a Text tab then has two seats for one verb depending on the tab. Whether that is acceptable or the pane-owned glyph should stand for every tab is undecided.
- **The unbound Session card.** [D185] records it folding to a blank box ([F11]). [B05]'s gate no longer requires a bound session, so the item goes live over it. Either the generic slit ([B02]) and the pane-owned control ([B06]) are what an unbound Session card gets — which would close [D185]'s open question — or it stays refused. Not asked.

---

## Non-goals {#non-goals}

- **A second rendering of the content for the folded form** — an excerpt component, a thumbnail, a summary line. Rejected by [B02]: the body clipped is true to the document, costs nothing per card, and keeps the reader's place.
- **Per-card folded heights.** A Text card standing at 72 + some number of whole lines would be tidier in isolation and would break the wall's one row height ([B01]).
- **Moving the Session card's control to the title bar.** One seat everywhere is attractive and is not this work ([B08]); it would re-open [D185]'s Z2 seat, its Return-home wiring and `at0552`.
- **Folding rails.** `setPaneFolded` refuses them and a rail's height is the allocator's ([F01]).
- **A Z2-style notice row for non-session cards.** The folded-card brief's `inhabit` / `defer` notices exist because a session calls for the user. A document's one unbidden event is the disk conflict, and [B10] gives it the masthead.
- **Keeping the status strip as the folded band.** Rejected by [B04].

---

## Exit {#exit}

**An arc.** The raw material, in the order the pieces depend on each other:

- The shared tier: the default folded policy in `card-registry.ts`, the constant's new home, and the Session registration reading it ([B01]).
- The command hoist and rename — action id, registry entry and gate, `host-menu-state.ts`, the Swift menu item's move to View, `tuglaws/menus.md` rows ([B05]). This lands before any new door, since the control and the chord both dispatch it.
- The generic folded form: body fills the band, top-anchored, `inert`; the Text card's strips out of layout under `data-folded` ([B02]–[B04]).
- The title-bar control, pinned while folded, as the key view with Return-home ([B06], [B07]) — the piece to look at in the running app before the rest is called done.
- Bidden surfaces and the conflict line on the Text card ([B09], [B10]).
- An app-test for a folded Text card (tier height, the slit's first line across fold and unfold, Return unfolds, a mixed wall packs), carrying `@covers`; [D185] amended to say the fold is the pane's and which parts remain the Session card's.
