# Column → slot rename

**Purpose:** The deck's vertical places are called *slots*, but the code, the wire vocabulary, persisted state and the laws still call them *columns*. Every user-facing string was fixed in `6e9a79ce2`; what is left is the internal vocabulary, which keeps leaking the wrong word back into the product.

---

## Purpose {#purpose}

The user: "We sometimes refer to *slots* as *columns*, and we shouldn't. The correct term is *slots*." They asked for a sweep of the app. The user-visible half is done (`6e9a79ce2`): the five slot rows moved to View as *Split or Stack Slot* and *Move Card … in Slot*, with `view.slot*` menu ids; the Layout card now captions *Slot N*; the command titles, help docs, `tuglaws/chord-tiers.md` and the generated tables in `tuglaws/menus.md` say *slot*.

What remains is everything a person does not read directly: type names, action ids, store fields, CSS classes, data attributes, file names, test names and the prose in `tuglaws/`. It matters because names leak. The Layout card said "Column 3" in a function whose own comment said slots, and the menu rows said "Column" because the commands were named `TOGGLE_COLUMN_SPLIT` and `MOVE_IN_COLUMN`. While the code says column, the next string someone writes will too.

---

## Evidence {#evidence}

**[F01] The vocabulary runs through every layer of the slot model.** Some examples: the type `ColumnMode` and `DeckColumn`, the selectors `columnMoveOrder` and `columnMembersOf`, `columnModeOf` in `lib/layout-imposer.ts`, the menu fact `CommandMenuFacts.column` and the `deck.menu` store's `column` field (added in `6e9a79ce2`), `PlaceRuns.column` / `getColumnRunHeight`, the place kind `"column" | "rail"` in `bus/declarations/pane.ts` and `deck-canvas.tsx`, the CSS custom property `--tug-slot-N-column-offset`, and the gauge `column-offset:N`. **(verified, by reading)**

**[F02] Files and components carry the word in their names.** `tug-column-badge.tsx`/`.css`, `lib/column-badge.ts`, `cards-column-badge.tsx`/`.css`, `chrome/column-seam-drag.ts`, `gallery-tug-column-badge.tsx`, `layout-imposer-columns.test.ts` and `tug-column-badge.test.ts`. The DOM carries it too: `tug-column-badge*` classes, `data-column-seam`, `data-column-split`, `data-column-member`, and `data-slot="tug-column-badge"`. **(verified, `rg --files`)**

**[F03] Four action ids are wire vocabulary, not just code.** These are `toggle-column-split`, `move-in-column` (with `:up/:down/:top/:bottom`), `set-column-mode` and `equalize-column` (`TUG_ACTIONS` in `lib/action-vocabulary.ts`). `tugapp/Sources/AppDelegate.swift` sends the first two by string (`sendControl("toggle-column-split")`, `sendControl("move-in-column", …)`). The keymap stores overrides as one tugbank key per command id in the `dev.tugapp.keymap` domain (`keymap-override-store.ts`), so renaming an id orphans any rebinding saved under the old one. **(verified, by reading)**

**[F04] Deck state persists the word.** `DeckImposition.columns` (`lib/layout-imposer.ts:380`) is written to and read from tugbank as the imposition record's `columns` key (`serialization.ts:545–607`). The user's live `release-main` layout holds `imposition.columns` for slots 0–3 today. Renaming the key without reading the old one would reset every workspace's split/stack arrangement and its shares. **(verified: read `dev.tugapp.deck.layout` on `release-main` read-only)**

**[F05] A raw count overstates the job, because many hits are true columns.** `rg -i column` finds about 4,000 hits in `tugdeck/src`, about 780 in `tugrust`, about 1,200 in `tests/app-test` and about 140 in `tuglaws`. Large shares of them are real columns: markdown/data tables (`enhance-table.ts`), SQL and FTS columns (`session_ledger.rs`), CodeMirror's `countColumn`, file:line:col locations, CSS `flex-direction: column` and `column-gap`, the Session card's `session-card-top-column`, gallery prose, and Rust in general. As far as a search shows, the slot sense is confined to `tugdeck`, `tugapp`'s two `sendControl` calls, the app-tests, and `tuglaws`; no Rust crate names the slot actions or the `columns` key. **(verified by search; the exact slot-sense count was not taken)**

**[F06] App-tests select on the DOM names.** 56 references in 17 app-test files use `column-badge`, `column-seam` or `data-column*` selectors, so any attribute or class rename moves them. Test file names such as `at0594-column-flip-cover-two` and the brief `briefs/column-flip-cover-brief.md` also carry the word. **(verified, `rg -c`)**

**[F07] The laws prose uses column as a term of art.** `tuglaws/design-decisions.md` (34 hits), `pane-model.md` (30), `animation-doctrine.md` (13) and others. Some of these name decisions and identifiers by their current spelling, for example `columnMoveOrder` in `pane-model.md`. **(verified, `rg -c`)**

---

## Decisions {#decisions}

**[B01] Slot is the one word for the deck's vertical places, in code as in the product.** The user named the term. An identifier is where the next user-facing string is copied from ([F01], and the two leaks fixed in `6e9a79ce2`). A split slot's members are *members of a slot*, never *a column*.

**[B02] The four action ids are renamed with a clean break; old keymap overrides are not migrated.** The ids become `toggle-slot-split`, `move-in-slot:*`, `set-slot-mode` and `equalize-slot`, and the two Swift `sendControl` strings move with them ([F03]). The standing premise is that Tug has no installs in the wild, so there is no audience for a compatibility bridge. The cost is that a hand rebinding of one of these chords is lost once; the chords themselves are defaults and come back unchanged.

**[B03] The persisted `imposition.columns` key is renamed to `slots`, and the reader accepts `columns` as a fallback.** This is the one place a clean break would cost the user something they can see: every workspace's split/stack arrangement on their own decks ([F04]). The reader takes `slots` when present and otherwise `columns`, and the writer writes only `slots`, so the old key falls out on the next save. The fallback goes through the existing record reader in `serialization.ts` and needs no ledger migration, because this is tugbank JSON and not a SQLite schema.

**[B04] Only the slot sense is renamed.** Real columns stay columns ([F05]): table columns, SQL columns, text positions, CSS flex direction, the Session card's top column, and Rust in general. The rename is selected by meaning, never by a blanket substitution. A mechanical `sub /column/slot/` across the tree is ruled out.

**[B05] File, class, attribute and test names follow the code.** The arrangement badge becomes `tug-slot-badge` (`TugSlotBadge`, `lib/slot-badge.ts`, `TugSlotBadgeKind`, `slotBadgeCharacter`), its Cards-row form becomes `cards-slot-badge`, and the other files in [F02] move the same way. It sits beside the existing position badge `card-slot-badge` without colliding (the name is unused today): `card-slot-badge` says *which* slot a card stands in, and `tug-slot-badge` says how that slot is *arranged*, stacked or split. The DOM names (`data-column-*`, `tug-column-*`) and the app-test selectors that read them ([F06]) move together, in the same change, so no selector points at a name that is gone.

**[B06] The laws are rewritten to say slot, but decision records keep their history.** Prose in `tuglaws/` that uses column for a slot is corrected. Identifiers quoted in the prose follow the code. A design decision's text in `design-decisions.md` is corrected for the term without being renumbered or re-argued ([F07]).

---

## Open Questions {#open-questions}

- **Does the shipped `TUG_ACTIONS` vocabulary appear anywhere outside this checkout — `tugplug`, help docs, a recorded corpus?** Nothing was found in `tugplug/` or `docs/`, but `tests/app-test/corpus/snapshots/*.jsonl` mentions the word. Grep the corpus for the four ids before renaming, and leave recorded transcripts as recorded.

---

## Non-goals {#non-goals}

- **Rewriting shipped release notes.** `release-notes/0.8.11.md` and `0.8.20.md` say "split column". Those releases are published in the appcast and on GitHub, and history stays as written.
- **A keymap migration shim.** It was considered and rejected under [B02]: there is no installed base to protect, and a rename table kept forever is the compatibility bridge the clean-break premise exists to avoid.
- **Renaming true columns** ([B04]).
- **Behaviour changes.** No change to what the slot verbs do, their chords, their gating, or the menu layout settled in `6e9a79ce2`. This arc is vocabulary only, and a red test it produces means a missed rename, not a reason to adjust behaviour.

---

## Exit {#exit}

**An arc.** It is wide but mechanical, so the order is what keeps the tree green between steps:

1. **The persisted key first** ([B03]): `DeckImposition.columns` → `slots`, with the `columns` read fallback, and its serialization tests. This is the only step with a user-visible failure mode, so it lands alone.
2. **The action ids and their two Swift senders** ([B02]), with the keymap and registry tests that name them, and the regenerated `tuglaws/menus.md` tables (`TUG_WRITE_MENUS_DOC=1` on `menus-doc.test.ts`).
3. **Types, selectors, facts and stores** ([F01]): `ColumnMode`, `DeckColumn`, `columnMoveOrder`, `CommandMenuFacts.column`, `deck.menu.column`, `PlaceRuns.column` and the rest. This is TypeScript-only and checked by `tsc` plus the unit suites.
4. **Files, components, CSS and DOM names, with the app-test selectors that read them** ([B05], [F06]). The `@covers` lines move with the files, and `just app-test-covers-check` is the guard.
5. **The laws prose** ([B06]).

The verdict for steps 4 and 5 is `just app-test-changed` over the moved selectors.
