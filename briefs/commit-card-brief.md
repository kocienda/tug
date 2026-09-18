# Commit Card

**Purpose:** A commit has no surface of its own. A commit atom in prose opens a Diff card, and the only place the commit's record is shown whole is an expanded row inside the Session card's History shade. Give a commit a standalone card, raised from the atom's menu and from a plain click on the atom.

---

## Purpose {#purpose}

The user's ask, in their words: "I want to make a standalone card for *commits*. I should be able to raise this card from commit atoms in the menu, and a plain click on the commit atom should show this card as well. Basic design is simple. Carve out what we show when we *expand* a commit in the history shade/sheet. The masthead for the card should be the header info we show in the history shade/sheet, with atom on the top line, commit message on the second line, and author/date/time on the third line."

The menu in question is the one a right-click on a `commit:<8>` pill in transcript prose raises today: Open Diff, Copy Short Hash, Copy Full Hash, Copy as Atom, Insert Atom into Prompt.

---

## Evidence {#evidence}

**[F01] The expanded commit lives inside the History list and nowhere else** — `CommitDetail` in `tugdeck/src/components/tugways/tug-history-list.tsx` renders the message body (`CommitMessage`), the changed-file roster (`CommitChangesList`, each row expandable to its own diff and carrying a `PopOutDiffButton`), and a right-aligned attribution line of `name <email> · full date`. It is a private function of the list module; no other surface can mount it. **(verified)**

**[F02] The row header is already built from shared pieces** — `CommitIdentityLine` and `CommitMetaCell` in `tugdeck/src/components/tugways/commit-presentation.tsx` render the pill plus subject and the author/date/time cluster respectively. The History row's header is those two components in a `TugListRow`. **(verified)**

**[F03] A plain click on a prose commit atom opens the Diff card** — the `commit-sha` registration in `tugdeck/src/lib/annotator/registry.ts` has a `primaryClick` that dispatches `TUG_ACTIONS.OPEN_DIFF` with a commit descriptor scoped to the confirmed `paths`. The menu's Open Diff item dispatches the same thing. **(verified)**

**[F04] Placed pills swallow the click** — `CommitShaText` (`tugdeck/src/components/tugways/commit-sha-text.tsx`) stops every pointer gesture, so the pill in a History row, a receipt header, and an Overview ref has no click behaviour. In a History row the row's own click folds the detail. **(verified)**

**[F05] The commit menu is authored once** — `commitMenuEntries` in `registry.ts` builds the list for every surface, with per-surface facts (`expanded`, `hasRecord`, `canOpenDiff`). History rows call it with `canOpenDiff: false` on purpose, since the row's files carry their own diffs. Prose mentions call it with no facts and get Open Diff plus the atom copy and insert. **(verified)**

**[F06] The Diff card is the model for a descriptor-keyed card** — `openDiffInCard` in `tugdeck/src/lib/open-diff-in-card.ts` reuses an open card by descriptor key through a live index (`diff-card-open-registry.ts`), else adds a card in the neighbor slot of the responder and flashes it. `registerDiffCard` in `cards/diff-card.tsx` declares content-width sizing and `takesContentWidth`. **(verified)**

**[F07] The masthead tier has two payload kinds and both compose `TugSessionRow`** — `card-title-store.ts` defines `SessionMastheadPayload` (a key, a store behind it) and `DocumentMastheadPayload` (title, description, detail as strings). `tug-pane.tsx` switches on the kind. `CardMasthead` composes `TugSessionRow` with a file glyph and a `TugPath`; the Session masthead composes it with a phase dot and callsign. The title line is a string in the document payload, so it cannot carry a pill. **(verified)**

**[F08] The commit-files reply already carries most of the header** — `GitCommitFilesPayload` in `tugdeck/src/lib/git-commit-files-store.ts` returns `subject`, `author`, and `date` (day only) alongside the files, built by `build_commit_files_snapshot` in `tugrust/crates/tugcast/src/feeds/git.rs` from one `git show`. It lacks the message body, the author email, and a time. A prose atom's payload (`CommitShaPayload`) holds only `sha`, `root`, `paths`. **(verified)**

**[F09] The commit atom is a settled entity** — `briefs/commit-atom-brief.md` and `tuglaws/entity-presentation.md` establish `TugCommitAtom` as the pill every commit surface wears, and `tugdeck/src/spikes/spike-commit-surfaces.tsx` shows every commit surface on one page. **(verified)**

---

## Decisions {#decisions}

**[B01] A new card kind, `commit`, registered in the Diff card's shape.** Content role, opens at content width in the neighbor slot of the card that raised it, closable, `takesContentWidth`. Seed is `{ root, sha }` plus an optional header hint (subject, author, date ISO). The Diff card is the precedent for a card raised from a commit entity, and matching its stature keeps a commit popped out beside a session reading at the same size.

**[B02] The card body is the History expansion, carved out into a shared component.** `CommitDetail` becomes `CommitRecordBody` in `commit-presentation.tsx`, beside the pieces it already composes ([F02]), and the files-fetch hook moves with it. The History row and the card mount the one component. The card is the expansion made standalone, so a second authoring of the body would drift the moment either surface changed.

**[B03] The card drops the trailing attribution line.** `CommitRecordBody` takes a flag for it, on for the shade and off for the card. In the shade the line exists because the row header shows only date and time; in the card the masthead's third line carries author, date, and time, and the body ends at the file roster.

**[B04] The masthead is three lines on the shared frame: the pill, the subject, then author · date · time.** Line one is `TugCommitAtom`, not text. Line three uses `CommitMetaCell` with all three fields at the tier's quietest rung. This is the History row header re-seated in the masthead tier, which is what the user asked for.

**[B05] A third masthead payload kind, `commit-masthead`, carrying `{ root, sha, subject, author, dateIso }`.** The document payload's title is a string and cannot hold a pill ([F07]), and a commit has no identity store behind a key the way a session does. The card publishes on every snapshot change, `tug-pane.tsx` switches on the kind, and a `CommitMasthead` composes `TugSessionRow` with the pill as the name, the way `CardMasthead` composes it with a glyph and path. No second authoring of the three lines.

**[B06] The masthead answers a right-click with the commit's own menu.** `useCommitIdentityMenu` claims the whole three lines with `hasRecord: true` and `canOpenDiff: true`. That is how the whole-commit diff stays one gesture from the card without the body growing a button. The user accepted this as the card's Open Diff door when the sketch was settled.

**[B07] Widen the commit-files reply rather than add a query.** `build_commit_files_snapshot` already runs `git show` for the sha ([F08]); it adds `body`, `author_email`, and a full ISO `author_date`, and the store type gains the same fields. A card raised from a prose atom then fills its masthead and body in the one round trip the shade already makes.

**[B08] The card always fetches; the hint covers only the first paint.** A card raised from the History shade carries the row's header so the masthead paints at once. A card raised from prose knows only a sha and shows the pill with stand-ins until the reply lands. One authority for the record, no matter who raised the card.

**[B09] A new action, Open Commit, and `openCommitInCard` as a mirror of `openDiffInCard`.** `TUG_ACTIONS.OPEN_COMMIT` takes `{ root, sha }`. The open path reuses an open card through a live index, else adds one beside the responder and flashes it ([F06]). The index matches when either sha is a prefix of the other, because prose writes eight characters and the reply returns forty.

**[B10] A plain click on a commit atom opens the Commit card.** The registry's `primaryClick` for `commit-sha` changes from Open Diff to Open Commit ([F03]). The confirmed `paths` stay on the payload for the menu's Open Diff.

**[B11] Open Commit joins the menu ahead of Open Diff.** In `commitMenuEntries` the open group reads Open Commit, Open Diff, then the copies. History rows keep the fold item first and add Open Commit after it, still without Open Diff ([F05]). A new `canOpenCommit` fact drops the row on a surface with no repository, parallel to `canOpenDiff`.

**[B12] Placed pills become clickable, and the click opens the card.** `CommitShaText` gains an activate path so the pill in a History row, a receipt header, and an Overview ref opens the Commit card, while the rest of a History row still folds ([F04]). The user's rule was that a plain click on the atom shows the card, and a placed pill is still the atom. This was flagged as the one widening of the ask when the sketch was settled and accepted with it.

**[B13] Tests that pin the click to the Diff card are re-pointed, and say so.** The decision they pin is the one this brief changes, so re-pointing is legitimate here. New app tests carry `@covers` for the card and the retargeted click. The commit-surfaces spike ([F09]) gains the card masthead so every commit surface still sits on one page.

**[B14] Doctrine records that a commit atom's primary act is its card.** `briefs/commit-atom-brief.md` and `tuglaws/entity-presentation.md` each gain a line saying so, so the Diff card's former role as the click target is not re-proposed.

---

## Non-goals {#non-goals}

- **A new wire query for one commit.** Rejected in favour of widening the existing reply ([B07]); a second message that answers the same `git show` would be a second authority.
- **Repeating the attribution line in the card body.** The masthead's third line says it ([B03]).
- **An Open Diff button in the card body.** The masthead's right-click carries it ([B06]), and every file row already has its pop-out.
- **Keeping Open Diff as the click on placed pills or in History rows.** History rows deliberately offer no Open Diff and that stays ([B11]).
- **A command-palette entry for Open Commit.** Not asked for; the card is raised from the atom.

---

## Exit {#exit}

**An arc.** The shape, in the order the seams want to land:

1. Widen the commit-files reply on both ends ([B07]).
2. Carve `CommitDetail` into `CommitRecordBody` with the attribution flag, and re-mount it in the History row ([B02], [B03]).
3. Add the `commit-masthead` payload kind, `CommitMasthead`, and the pane switch ([B04], [B05], [B06]).
4. Register the `commit` card and write `openCommitInCard` with its live index ([B01], [B09]).
5. Add `OPEN_COMMIT`, retarget the primary click, add Open Commit to the menu with its fact, and make placed pills clickable ([B10], [B11], [B12]).
6. Re-point pinned tests, add covered tests, extend the spike, and update doctrine ([B13], [B14]).
