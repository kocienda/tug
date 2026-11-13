# Rename a session inline from the masthead

**Purpose:** A session can only be renamed through a sheet, reached by typing `/rename` or by the Session menu. The masthead shows the name and offers no way to change it where it stands.

---

## Purpose {#purpose}

The user asked for two affordances on the Session card masthead:

> 1. Add a Rename Session option to the right-click menu
> 2. Add a pencil item when hovering over the session name
>
> Either option should make the name editable right inline in the header. Esc cancels. Return accepts.

The masthead's right-click menu today reads Current Session (dimmed) · Copy as Atom · Copy as Citation · Copy Session ID · Copy Description · Copy Activity Line. It copies the session's facts and changes none of them.

---

## Evidence {#evidence}

**[F01] The rename path is complete and lives inside the sheet's hook** — `useRenameSessionSheet` in `tugdeck/src/components/tugways/cards/rename-session-sheet.tsx` holds `commitRename`: it reads the card's binding fresh, writes the name to `sessionNameStore` optimistically, registers a settle waiter holding the replaced name, sends the `rename_session` frame, and on the ack raises a success or sticky danger bulletin (naming any line the name was taken from). A blank name clears the name. The function is a `useCallback` closed over `cardId` and `notify`, so nothing outside the hook can call it. **(verified)**

**[F02] Every door to rename opens the sheet** — `session-card.tsx` wires the `rename` slash command: `/rename <text>` calls `renameTo`, bare `/rename` calls `openRenameSheet`, and `/unname` calls `renameTo("")`. The Session menu's **Rename Session…** is `session.rename` in `tugdeck/src/components/tugways/command-registry.ts`. No surface edits the name in place, and a search of `tugdeck/src` found no inline-edit primitive to reuse. **(verified)**

**[F03] The masthead menu's list and order are the registry's** — `useSessionIdentityMenu` (`tugdeck/src/components/tugways/session-identity-menu.tsx`) asks `sessionMenuEntries` in `tugdeck/src/lib/annotator/registry.ts` for its entries, passing surface facts (`isOwnCard`, `openCardId`, `resumable`, `description`, `activity`). `sessionMenuEntries` builds through `buildEntityMenu` with `goTo`, `copy` and `send` blocks and no `act` block. `tuglaws/menus.md` fixes the order as go to it · act on it · copy it · send it, and says a surface never states items of its own. **(verified)**

**[F04] The menu's actions land on the hook's own responder** — each item is a typed action handled in the `actions` map of `useOptionalResponder` inside `useSessionIdentityMenu`; there is no `RENAME_SESSION` in `TUG_ACTIONS`. **(verified)**

**[F05] The masthead's title is rendered three components down, in the pane title bar** — `session-masthead.tsx` mounts `SessionIdentityRow` with `identityMenu`, `grabHandle` and `hostCardId={cardId}`; the row renders `SessionIdentityView` at the `line` tier, whose name run is `span.tug-session-identity-name`, followed by the `^arc` run. The masthead is above the card host, outside `CardIdContext`, and its lead line is the chrome's one drag surface. **(verified)**

**[F06] An unnamed session's title is its `project/callsign`** — `sessionTitleParts` yields the custom name when there is one and the bare `project/callsign` otherwise ([D141]: a custom name shows no callsign beside it). So the text on screen is not always a name the user wrote. **(verified)**

---

## Decisions {#decisions}

**[B01] One inline editor on the masthead, opened by every rename door.** A small per-card store, read through `useSyncExternalStore` [L02], records whether a card's masthead is in rename mode. The right-click item, the pencil, bare `/rename` and Session › Rename Session… all set that one flag. Three doors onto one editor cannot drift into three behaviours.

**[B02] Rename Session… is the session menu's act block, offered only where the surface says so.** `sessionMenuEntries` gains an `act` row gated on a new surface fact (`renamable` or similar), which only the masthead sets; the menu reads Current Session · rule · Rename Session… · rule · the copies. Citation chips and rows on other cards do not gain the item — the user asked for the masthead, and a rename from a chip in someone else's transcript is a different feature. The action is a new `RENAME_SESSION` on the hook's responder, routed to an `onRename` option, per [F03] and [F04].

**[B03] A pencil button follows the name and shows on hover of the name.** It sits after the name run and before the `^arc` run, revealed by CSS `:hover` alone [L06]. Its press must not begin a drag, since the lead line is the grab handle [F05].

**[B04] In rename mode an input replaces the name run, in the title's own type.** It is seeded with the custom name. For an unnamed session it opens empty with `project/callsign` as the placeholder, because per [F06] the text on screen is a minted handle, not a name to edit.

**[B05] Return commits, Esc cancels, and clicking away commits.** The user settled the blur case: commit, as Finder does, leaving Esc the only cancel. A blank commit clears the name, the existing `/rename` semantics. When editing ends, focus returns to where the card keeps it (the composer), since the masthead is chrome outside the card host.

**[B06] The commit is the existing one, lifted out of the sheet hook.** `commitRename` [F01] becomes a plain function the masthead and the slash command both call, keeping the optimistic write, the settle waiter, the restore on refusal and the ack-time bulletin exactly as they are. The inline editor makes no claim of success on the gesture; the bulletin still speaks on the ack.

**[B07] The rename sheet is retired.** The user agreed. `/rename <text>` and `/unname` keep renaming directly; bare `/rename` and the menu-bar item open the inline editor. `RenameSheetBody` and `openRenameSheet` go, and tests written for the sheet move to assert the same guarantee — a seeded field, Return commits, Esc cancels — on the inline editor. That is a stated reversal of the sheet as the bare-`/rename` surface ([#step-13d]), not a quiet re-point.

---

## Open Questions {#open-questions}

- None the user has to answer. One thing the work has to establish: how the input takes and returns the key view from the title bar, which is outside the card host's focus scope. A folded card is the masthead alone, so the editor has to work there too.

---

## Non-goals {#non-goals}

- **Rename from other session surfaces.** Citation chips, Cards-card rows and the session chooser keep their menus as they are. [B02]'s surface fact is the gate.
- **A second rename surface.** The sheet is not kept beside the inline editor as a fallback [B07].
- **Any change to the rename wire or ledger.** `rename_session`, the name store's settle and the displaced-name bulletin are untouched [B06].
- **Editing the callsign.** The editor sets the session's name; the callsign stays minted, and clearing the name brings it back.

---

## Exit {#exit}

**An arc.** Its raw material, in the order it must land:

1. Lift `commitRename` out of `useRenameSessionSheet` into a callable function; `/rename <text>` and `/unname` go through it unchanged.
2. Add the rename-mode store, the `RENAME_SESSION` action, the `renamable` fact and the act-block row in `sessionMenuEntries`, with a unit test that the row appears only under the fact and sits between the go-to and copy blocks.
3. Build the inline editor in the line-tier name run, and the hover pencil; wire Return, Esc and blur per [B05].
4. Point bare `/rename` and `session.rename` at the editor, remove the sheet, and move its tests per [B07].
5. One app-test: the menu item and the pencil each open the editor, Esc leaves the name unchanged, Return and blur rename, and a press on the pencil does not drag the card. `just app-test-select` supplies the existing rename and masthead files by `@covers`.
