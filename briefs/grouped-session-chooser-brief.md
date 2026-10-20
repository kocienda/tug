# The Choose Session sheet lists sessions grouped by project, and fits the card it stands in

**Purpose:** New sessions keep landing in the wrong project, because the sheet opens on the last project used anywhere and asks for the project through a three-part path control that is hard to read and harder to drive. The settled design removes the project step: one list of sessions grouped by project, the workspace's own group open. That list is taller than the sheet it replaces, so it must lay out properly in a card that has been given limited vertical space, as the lower member of a split row.

---

## Purpose {#purpose}

The user's words, opening the design spike:

> The new session sheet kinda sucks. I often create sessions in the wrong project, especially as I switch between workspaces that are for different projects. The three-part project path control isn't working. It's too confusing to use and get what I want.

Three treatments were drawn in `tugdeck/src/spikes/spike-session-chooser.tsx` and the user chose the third ("Option (C) is really the way to go"), then asked for it at shipping fidelity, then settled the project band's shape over three rounds. What remains is to roll it into the shipped picker, and the user's closing requirement:

> we need to ensure that these new sheet will display properly when it is given limited vertical space in a card that is being shown in a split row.

---

## Evidence {#evidence}

**[F01] The sheet opens on the globally most-recent project, not the workspace's.** `seedPathFrom` in `tugdeck/src/components/tugways/cards/session-picker-seed.ts` takes, in order, the first entry of the tugbank `recent-projects` list, the default-project setting, the host's launch hint, then home. The recents list is machine-global and most-recent-first, so after a stint in another workspace a new session card in this one opens on that workspace's project. Nothing in the seed consults the workspace the card was opened in. **(verified by reading the seed and its tests in `session-picker-seed-path.test.ts`)**

**[F02] The workspace already knows its project.** Every bound session card's binding carries `projectDir`, and `frontmostProjectBinding` in `tugdeck/src/lib/frontmost-project.ts` already walks the deck front-to-back to find the most-frontmost bound card for Open Quickly. The same walk, deduplicated over `projectDir`, is the workspace's project set. **(verified)**

**[F03] The shipped control offers three live doors for one choice.** `TugFileChooser` in the picker is a Browse button, a typed completing path combo, and a chevron that opens the recents as a menu, all live at once. The recents' paths differ only at their tails (`…/u/src/tug` against `…/u/src/eucit`), so a wrong default does not look wrong. **(verified by reading `session-picker-form.tsx` and `tug-file-chooser.tsx`; the "wrong project" reports are the user's)**

**[F04] The ledger lists sessions per project directory.** `list_sessions` is a CONTROL request keyed on one `project_dir`, answered by `list_sessions_ok` for that directory, and `session-ledger-store.ts` caches one `WorkspaceSnapshot` per path. There is no cross-project listing on the wire. A grouped list is therefore a fan-out: one request per project the sheet shows, each settling its own group. **(verified by reading `protocol.ts` and `session-ledger-store.ts`)**

**[F05] The spike's grouped sheet is built from the picker's own parts, and the band's shape is settled.** The spike mounts the real `.tug-sheet-*` panel at the picker's `lg` width, the picker's `session-card-picker-*` body, `TugFilterField` attached to the list, `SessionIdentityRow` with the picker's exact knobs, the Move-all-to-Trash row and the Cancel/Open actions. New to the design: a project band row, a per-group "New session in X" row, a "New session in another folder…" row, Open labelled with its project, and a taller list cap. The band is two lines: chevron, basename in the row's title label, and the facts on the first; the full path on the second, mounted as `TugPath` directly in the row's `children` so it takes the column's width and never truncates at the sheet's width. The subtitle slot was tried and rejected: it wraps its content in a clamped `TugLabel`, which sizes a path to fit rather than to the line. **(verified: the spike builds, type-checks, and passes the taxonomy and drift tests; three rounds of the user's screenshots settled the band)**

**[F06] The unbound Session card is pinned at the height of the current picker with its list at its cap.** The `picker-height-list-cap` arc (`f76a133ad`) pinned the card at 618px: a 542px panel read off the built app with the list at its 14.5rem cap, plus title bar, clip drop, panel margin and `SHEET_CANVAS_GAP`. The Sessions list is `max-height: 14.5rem` with a 3.5rem floor per row. `at0569` makes the fit claim on the lower member of a split column over a seeded five-session project (`tests/app-test/picker-sessions-fixture.ts`): panel at natural height, header wholly below the title bar, action row wholly above the frame's bottom. **(verified from the arc's commit and the test's docblock)**

**[F07] The grouped list is taller than the pin was measured for, and a split row can be shorter than either.** The spike's list cap is 34rem against the shipped 14.5rem, and a band is a second row kind the pin never saw. The Session card's size floor is 600px (`session-card-registration.tsx`), the deck clamps a new card to 90% of the canvas, and a split row divides the canvas between its members, so the lower member of a split on a laptop canvas can stand well under the pin. Today the sheet answers a short frame by capping the whole panel against the canvas bottom and scrolling it as one piece (`.tug-sheet-content` is `overflow-y: auto` with an inline `max-height` from `tug-sheet.tsx`'s clamp), which is the cut-off header and action row of the earlier screenshot. **(the cap and clamp are verified by reading; that the grouped panel exceeds the pin on a real project is arithmetic, and the number is the arc's to measure)**

**[F08] The sheet already has a layout in which only the body scrolls.** `.tug-sheet-content[data-resizable="true"]` is a flex column with `overflow: hidden`, and its `.tug-sheet-body` is `flex: 1 1 auto; min-height: 0`, so a consumer's footer stays visible while the body scrolls (`tug-sheet.css`, the resizable section). That layout is reached only through `resizable`, which also mounts drag handles. The picker's `OpeningForm` (`card-registry.ts`) carries `panel`, `displayWidth`, `title` and `icon`, and the card presents it with `presentation: "none"` and no resizing. **(verified)**

**[F09] A sheet on a short pane is allowed to grow past the frame before it scrolls.** `session-sheet-visibility-brief.md` [B02] decided that a sheet is sized against the visible canvas, grows past its frame down first and then up, and scrolls only when taller than the canvas. The picker is a top-anchored sheet and is subject to the same rule. So "limited vertical space in a split row" has two regimes: a canvas tall enough for the panel, where the panel may stand past the frame; and a canvas shorter than the panel, where something inside the panel has to give. **(verified by reading the brief; whether that arc has fully landed is for the arc to check against `tug-sheet.tsx`)**

**[F10] Recents carry their own management that the grouped list must keep.** The combo box's dropdown lets a recent path be removed (`requestTrashRecent`, `putSessionRecentProjects`), and the picker probes each recent for existence (`probeDirExistence`) and marks the missing ones. The trash-all row is worded "for this path". **(verified)**

---

## Decisions {#decisions}

**[B01] The project step is removed. The sheet is one list of sessions grouped by project.** The user chose this over a project menu button and over a projects-beside-sessions master/detail, having seen all three on the deck. A project is a consequence of the row picked, never a prior decision, so a session cannot be created in a project the user did not just read the name of. The three-part path control leaves the sheet; typing a path and Browse survive behind one row, "New session in another folder…", which is the exception and reads as one.

**[B02] The groups are the workspace's bound projects, then the recent projects, in that order, and nothing else.** The workspace's projects come from the deck's bound cards ([F02]), deduplicated by `projectDir`, frontmost first; the recents follow in their stored order, minus any already shown. A project is a group whether or not it has sessions, so a workspace project with none still offers its New session row. This is the fix for [F01]: the seed order becomes workspace project, then recents, then the default-project setting, then the host hint, then home, and the first group is the one that opens expanded and holds the initial selection.

**[B03] The workspace's groups open expanded; every other group is folded; a filter unfolds and hides.** A folded group shows its band only: name, path, "N live · M sessions". The workspace's band wears a "this workspace" badge. Typing in the filter trims rows across every group, unfolds any group with a match, and hides any group with none, because the reader asked for rows and not for structure. The filter is the shipped `TugFilterField`, attached to the list as it is today, and the match grammar is the one the picker already uses.

**[B04] The band is a list row of two lines, and the full path is the second line, never truncated at the sheet's width.** The band is a `TugListRow` so the keyboard cursor reaches it and Enter folds or unfolds it. Its first line is the basename in the row's title label with the chevron leading and the facts trailing, aligned to that line rather than centred across both. Its second line is `TugPath` mounted directly in the row's `children`, taking the column's full width ([F05]). The path is the fact the user named as important and the thing the old control hid at a glance; it shortens in the middle only when the sheet itself is narrower than the path, which at the `lg` width no ordinary path is.

**[B05] Each group carries its own New session row, and Open names the project.** The row reads "New session in tug". The Open button reads "Open in tug" and follows the selection's project. Both are the same guard said twice: the last thing read before committing is where the session goes.

**[B06] The grouped list is a fan-out over `list_sessions`, one per group, and a group settles on its own.** There is no cross-project listing ([F04]) and none is added: the group set is small and already known client-side ([B02]), and a per-path request is what the store caches and re-issues on `session_updated` today. A group whose request is pending shows its band with a quiet pending mark instead of counts; a group whose directory is missing ([F10]) says so on its band and offers its remove action there. The `WorkspaceSnapshot` cache and its invalidation are untouched.

**[B07] Under limited height, the list is the one thing that gives; the header, the filter, the trash row and the actions never leave the screen.** The sheet's body becomes the flex-column, body-scrolls layout the resizable sheet already has ([F08]), reached through a layout option on the sheet rather than through `resizable`, so no drag handles appear. With the panel capped by the canvas clamp, the shortfall lands on the list, whose cap becomes "the room left" rather than a fixed rem. The list keeps a floor of three rows (one band, one New session row, one session row at the 3.5rem floor), and below that floor the panel is allowed to stand past the frame under [F09]'s rule rather than crush the list further. This is the whole of "display properly in a split row": nothing above or below the list is ever cut off, and the list scrolls inside a frame that reads as one sheet.

**[B08] The unbound card's pin is re-measured against the grouped picker, and the pin's meaning changes from "the picker at its tallest" to "the picker with the list at its preferred height".** `picker-height-list-cap-brief.md` [B01] pinned the card at the list's cap because the cap bounded the picker. With the list flexing ([B07]) the picker no longer has one height, so the pin becomes the height the card asks for when it has room: the grouped picker with the workspace's group open over the seeded fixture's five sessions, measured in the built app as before ([B02] of that brief), with a doc-comment that records the condition. A shorter card is no longer a defect the pin must prevent; it is the case [B07] lays out for.

**[B09] The trash-all row is re-pointed at the selection's project.** "Move all sessions to Trash for this path" presumed one path on screen. The grouped sheet reads "Move all sessions in tug to Trash", following the selected row's group, disabled when that group holds no non-live session. The per-row trash and its confirm popover are unchanged.

**[B10] The spike graduates and is deleted.** The band rules move into `session-card.css`, the row composition into `session-picker-cells.tsx`, and the spike file with its two registry lines is removed in the same change that ships the picker, so the deck does not carry two Choose Session surfaces.

---

## Open Questions {#open-questions}

- **Whether the project groups should also show projects that have sessions but are in neither set.** The ledger knows every `project_dir` it has rows for, but only per request ([F04]), so a "projects with sessions I have forgotten" group needs either a new listing or a scan. The user's complaint is about the known set; this brief ships the known set and leaves the rest to a later ask.

---

## Non-goals {#non-goals}

- **A project menu button (treatment A) or a projects-beside-sessions master/detail (treatment B).** Both were drawn, both were seen, and the user chose against them. Not to be re-proposed.
- **A cross-project `list_sessions` on the wire.** [B06] answers the grouped list without a server change. Revisit only if the open question above is taken up.
- **Deriving the card's pin from the session count.** Rejected in `picker-height-list-cap-brief.md` [B04] and still rejected: [B07] makes the picker fit whatever height it is given, which removes the pressure that argued for a computed pin.
- **Drag-resizable picker.** The body-scroll layout is borrowed from the resizable sheet; the handles are not.
- **Touching the picker's arrival choreography** (`picker-card-arrival`), the restore notice, or the resume path. The sheet's contents change; how the card arrives with it does not.
- **A truncated or middle-ellipsized path on the band at ordinary widths.** Tried in the spike and rejected by the user three times. The path is the second line and it is whole.

---

## Exit {#exit}

An arc.

The order that matters: first, the sheet's body-scroll layout as an option the picker can ask for without `resizable` ([B07], [F08]), since the list cap and the pin both depend on it. Then the data side: the group set from the deck's bindings and the recents ([B02]), the per-group fan-out and its pending and missing states ([B06]), and the seed order that makes the workspace's project first ([B02]). Then the sheet itself, carrying the spike's rows and band into `session-picker-cells.tsx` and `session-card.css` ([B04], [B05], [B09]) and deleting the spike ([B10]). Then the pin: re-measure in the built app over the seeded fixture with the workspace's group open ([B08]). Last, the tests: `at0569` and `at0571` over the grouped picker on the lower member of a split column at a height under the pin, asserting that the header, the filter, the trash row and the actions are all wholly inside the frame and that the list is the element that scrolled ([B07]); the seed-path unit test over the new precedence ([B02]); and a by-eye look on the `tug` project in a split row, which the previous arc recorded as not performed.
