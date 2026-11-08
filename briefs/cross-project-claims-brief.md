# Cross-project claims

**Purpose:** A session rooted on another project can edit files in this one, and while that session's line is live, those files show in no card. A Session card must name the other project and session that changed a file in its project.

---

## Purpose {#purpose}

On 2026-11-08 `git status` in the tug checkout showed six changed files: `tests/app-test/site-clips/_rails.ts`, `tests/app-test/site-clips/_site-clips.ts`, `tugdeck/src/components/tugways/cards/session-arc-note-block.css`, and three `tests/app-test/video/vd-*.test.ts` files. In the user's words: *"no card shows these as claimed by another session that has been closed, and they don't show as unattributed in this card. What gives?"*

The user's requirement: *"Session rooted on this project **must** show me the other project that edited this file."* And the limit on it: the facility shows only *"when some other project's session modified files in the session's project directory I'm looking at."*

---

## Evidence {#evidence}

**[F01] The ledger attributed the files correctly.** `tugtool changes --json` from the tug session put all six files in `foreign`, owned by `bee12ec5-508a-46a1-b6e2-d3129922d682`. That is `lordly-thyme`, whose project is `/Users/kocienda/Mounts/u/vids`. In `changes.db`, `file_events` holds 80 rows from that session stamped `project_dir = …/src/tug`, 4 stamped `…/src/tug-site` and 426 stamped `…/vids`. Rows are stamped with the project the *file* belongs to, not the session's own project. **(verified)**

**[F02] The owning line is live through a newer segment.** In `release-main`'s `sessions.db`, `bee12ec5…` is `closed`. Its line `5126bdf8-a073-48d2-8dd7-79bf5d559149` also holds `f5dc16cc-f803-4c5c-bcd0-f74d00f12487`, which is `live`, also rooted on `/u/vids`, and last updated at 2026-11-08T22:36Z (turn 63). The user believed the session was closed. Only the segment that wrote the rows was. **(verified)**

**[F03] The orphan lift tests liveness, not visibility.** `compose_snapshot` in `tugrust/crates/tugcast/src/feeds/changeset.rs` (the block at the `Orphan lift ([D120])` comment) moves a file into `orphaned` only when *every* owner is dead. The comment states the premise: *"no live card surfaces another session's entry"*, which is taken to imply that a live owner's own card surfaces it. Owner liveness is folded per line (`line_ownership` → `any_live`, plus deck seatings), so `f5dc16cc`'s liveness keeps the files in `lordly-thyme`'s entry. **(verified, read from code)**

**[F04] The live owner's card never reads this project's changeset.** A Session card reads the changeset of the project it is rooted on. `lordly-thyme`'s card is rooted on `/u/vids` and never composes tug's snapshot. A tug card shows its own entry, `unattributed` and `orphaned`, and never another session's entry. So a file owned by a live session rooted elsewhere is visible on no card. Every cross-project edit falls into this gap for as long as the editing line is alive. **(verified for this case, read from code and the ledgers; the deck-side rendering of `orphaned` is in `tugdeck/src/components/tugways/tug-changes-list.tsx`)**

**[F05] The CLI matches the feed.** `tugtool changes` (`tugrust/crates/tugchanges-core/src/changes.rs`) reports these files only as `foreign`. Nothing there separates "another session in this project" from "a session rooted on another project". `just app-test-changed` never selects the foreign bucket. **(verified)**

---

## Decisions {#decisions}

**[B01] A file in this project that a session rooted on another project changed is shown on this project's Session cards, naming the other session and its project.** This is the user's requirement. The owner's liveness does not matter. A live owner rooted elsewhere is exactly the case that is invisible today ([F04]). A dead owner rooted elsewhere already lifts as an orphan, but the row should still say which project it came from.

**[B02] "Rooted elsewhere" is decided by repo root, not by raw `project_dir`.** An owner counts as *elsewhere* when the project its line's seat is rooted on resolves to a different repo root than the project being composed. A session rooted on a subdirectory of this checkout, or on this checkout under another spelling, is not elsewhere. An arc worktree is its own repo root and composes its own snapshot, so it is unaffected. The seat's project comes from the seat row that `line_ownership` already resolves. It is compared after canonicalization, the same way `compose_snapshot` already compares paths.

**[B03] The facility appears only when such a file exists.** If no session rooted on another project has a live claim on a dirty file in this project, nothing new is drawn. No empty section, no header, no setting. Claims by same-project sessions behave exactly as they do today: a live same-project owner keeps the file in its own entry, and a dead one lifts it to `orphaned`.

**[B04] Elsewhere files ride the orphaned bucket with a reason, and keep its Claim affordance.** `OrphanedFile` gains a reason, `closed` or `elsewhere`. An `elsewhere` row shows the owner's citation chip and the owner's project leaf (for example, *changed by lordly-thyme in vids*), never the closed-session wording, because the owner may still be working. Claim works as it does for an orphan, so this project's session can take the files and land them. One bucket with a reason is chosen over a new parallel bucket because the deck already renders, labels and claims from `orphaned`. What differs is the words, not the gestures.

**[B05] The ownership rule changes in one place and both readers apply it.** The snapshot feed and `tugtool changes` must agree. The CLI marks a foreign entry whose every owner is rooted elsewhere with an `elsewhere` flag and that project. The rule ("an owner rooted on another repo root does not count as surfacing the file here") should live where both can call it. What it needs is a session row's project and a repo-root comparison, both available to `tugchanges-core`.

**[B06] The case that prompted this is the acceptance case.** A closed segment wrote the rows, and a live segment of the same line is rooted on another repo. Those files lift as `elsewhere` on the tug card and name `lordly-thyme` and `vids`. The other required cases: a live same-repo owner keeps its files, and a dead same-repo owner lifts as `closed` as before. These sit beside `compose_lifts_dead_only_owned_files_into_orphaned` in `changeset.rs`.

---

## Open Questions {#open-questions}

- **Does `app-test-changed` select elsewhere files?** Today it reads the attributed bucket plus this-session unattributed hints, and never `foreign`. An elsewhere file that this session has not claimed is still somebody else's work. The default is to leave selection unchanged until the file is claimed, at which point it is attributed and selected. Settle this when the CLI flag lands, because the selector reads that JSON.

---

## Non-goals {#non-goals}

- **A note on the editing session's own card** ("also changed 6 files in tug"). The user scoped the facility to the card rooted on the project whose files were changed ([B03]). The author's card stays as it is, and committing across repos from that card is not something it should offer.
- **Showing other same-project sessions' entries on this card.** Same-project claims are already visible on their owners' cards. The gap is only cross-project ([F04]).
- **Changing how rows are stamped.** Stamping `file_events` with the file's project, not the session's, is correct ([F01]) and is what makes this fix possible.
- **Treating a rotated line as closed.** The line really is live ([F02]). Calling it closed would be the misreading the user started from, written into code.

---

## Exit {#exit}

An arc. First steps, in order:

1. The shared rule from [B02]/[B05]: given an owner's line seat and the repo root being composed, decide *same repo*, *elsewhere* or *dead*. Unit tests cover the subdirectory and canonical-spelling cases.
2. `compose_snapshot`'s orphan lift applies it, `OrphanedFile` carries the reason and the owner's project, and the three compose tests from [B06] are added.
3. `tugtool changes` carries the `elsewhere` flag and project on foreign entries, then the [Open Questions](#open-questions) selector call is settled.
4. The deck's orphaned rows render the `elsewhere` wording and project per [B04], with the label shown only when such rows exist ([B03]).
