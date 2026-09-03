# Everything modal rests on Z2 and grows up

**Purpose:** A Session card is a transcript: content arrives at the bottom and the history scrolls away above it. The card's modal surfaces do not follow that grain — most of them drop from the pane title bar and grow downward, against the direction the card's own content moves. This brief sets one rule — a modal surface rests on the top edge of Z2 and grows *up* toward the masthead — names the surfaces that already obey it, the surfaces that must change, and the three exceptions the user has ruled out of it.

The user's frame (2026-09-03): "this chat/transcript model appends content to the end rather than from the top … when these displays need to grow (like the History shade does), it should grow *up* toward the top of the card's titlebar/masthead."

---

## Purpose {#purpose}

The Session card's top column stacks in this order: Z0 masthead → view slot → find bar → Z2 status bar → PULSE, with the prompt-entry region below the column. Two facilities for anchoring a modal surface at the bottom of that stack already exist and are already in use, but only three surfaces use them; everything else inherits the top-anchored default from `TugSheet`, which drops a panel from the pane title bar.

The result is a card whose surfaces disagree about which edge is home. The History shade — the surface the user named — is mounted in the view slot with the default top anchor, so it hangs from under Z0 and grows *down* toward Z2 as the log pages in. The Changes shade, one flex sibling away, does the opposite. The Z4B pickers do the opposite. The fifteen panel sheets do neither: they portal to the pane frame and drop from the title bar at the far end of the card from the chip or menu item that opened them.

This is a geometry-and-doctrine change, not a behaviour change. No surface gains or loses a state, a focus rule, or a dismissal path.

---

## Evidence {#evidence}

**[F01] Three anchoring facilities exist; the doctrine that would choose between them does not.** `TugSheet` supports `shadeAnchor="bottom"` for the full-width `shade` presentation (`tugdeck/src/components/tugways/tug-sheet.tsx:779`, CSS at `tugdeck/src/components/tugways/tug-sheet.css:634`, mirrored roll at `:697`), and `bottomAnchorSelector` for portaled panel sheets, which measures an element and pins the clip's bottom edge to it (`tug-sheet.tsx:1067`, CSS at `tug-sheet.css:111`). Absent either, a sheet is top-anchored under the pane chrome. Nothing in `tuglaws/` says which a Session card surface should take. **(verified — read all three)**

**[F02] The anchor the rule needs is already a named constant.** `tugdeck/src/components/tugways/cards/picker-sheet-anchor.ts:17` exports `PICKER_SHEET_ANCHOR = ".session-view-slot"` — the view slot's bottom edge, which is the top of Z2, or the top of the find bar while the bar is open (the find bar is a flow sibling between the slot and Z2, `session-card.tsx:5245`). Its docstring scopes it to the Z4B pickers. It has exactly one call site: `cards/ai-config-sheet.tsx:251`. **(verified)**

**[F03] History is top-anchored, and the prose around it already says otherwise.** `session-card.tsx:5226` mounts it with `presentation="shade" persistKey="session-card" shadeAutoSize` and no `shadeAnchor`, so `tug-sheet.css`'s default `top: 0` applies inside `.session-view-slot`. Meanwhile `session-card.css:130` describes it as "History fills the view slot (rising from Z2)" and `picker-sheet-anchor.ts:6` calls the same edge "the same anchor the Changes and History shades rise from." The documentation was written for the design this brief charters; only the code disagrees. **(verified — read both comments and the mount)**

**[F04] Three surfaces already rest at the bottom, by two different definitions of it.** The Changes shade (`session-card.tsx:5338`) takes `shadeAnchor="bottom"` inside a wrapper that is `.session-card-top-column`, so its bottom edge is the top of the **prompt-entry region** — it covers Z2 and PULSE. The AI Model Settings sheet (`ai-config-sheet.tsx:250`) takes `presentation: "rise"` + `bottomAnchorSelector: PICKER_SHEET_ANCHOR`, so its bottom edge is the top of **Z2**. The find bar is not an overlay at all — it is a real flow sibling, and is the shape the rest are being asked to imitate. **(verified)**

**[F05] Fifteen panel sheets are top-anchored, all opened from the Session card.** Usage (`usage-sheet.tsx:104`), Help (`help-sheet.tsx:129`), Memory (`memory-sheet.tsx:77`), Agents (`agents-sheet.tsx:79`), Skills (`skills-sheet.tsx:81`), Hooks (`hooks-sheet.tsx:70`), Permissions (`permission-rules-editor.tsx:812`), Rewind (`rewind-sheet.tsx:148`), Rename Session (`rename-session-sheet.tsx:131`), Resume Session (`resume-sheet.tsx:125`), Choose Session (`session-card.tsx:1052`), Work on an arc (`session-card.tsx:4347`), Compacting (`session-compaction-run.tsx:223`), Attachment preview (`cards/tug-attachment-preview.tsx:485`), Card Settings (`card-settings-sheet.tsx:113`). None passes `bottomAnchorSelector`. **(verified — read every call site's options block)**

**[F06] `TugAlert` is centred on the viewport.** `tugdeck/src/components/tugways/tug-alert.css:88` is `position: fixed; top: 50%`. `tug-alert-sheet.tsx:143` routes alert-shaped content through `showSheet` instead, so that path inherits whatever the sheet default becomes; the centred `TugAlert` is the outlier that does not. **(verified)**

**[F07] The attachment preview's resize handles assume a pinned top.** `tug-sheet.tsx:217` declares `SheetResizeEdge` as `"e" | "w" | "s" | "se" | "sw"` and the docstring above it says so explicitly: "the sheet is top-anchored … there is no north handle." `tug-attachment-preview.tsx:498` is the only `resizable: true` sheet. Bottom-anchored, its one vertical handle grows the panel in the wrong direction. **(verified)**

**[F08] The transcript's own dialogs are already right, and are the model.** The permission dialog (`chrome/session-permission-dialog.tsx`) and the question wizard (`chrome/session-question-dialog.tsx`) are inline blocks in the transcript flow — "never a modal overlay," in the permission dialog's own words. They arrive at the tail because everything in a transcript arrives at the tail. That is the grain the overlays are being aligned to. **(verified)**

---

## Decisions {#decisions}

**[B01] One rest line: the bottom edge of the view slot.** A modal surface on a Session card rests on `.session-view-slot`'s bottom edge — the top of Z2, or the top of the find bar while it is open — and grows upward from there. One line, one constant, no per-surface judgement.

**[B02] The anchor constant stops being a picker detail.** `PICKER_SHEET_ANCHOR` is renamed and re-documented for what it now is: the card's single modal rest line, not the Z4B pickers' private arrangement. Its docstring carries [B01]. The fallback stays as it is — a host with no view slot (the settings session card body) matches nothing and falls back to the top anchor, which is correct and needs no exception clause.

**[B03] Changes is exempt and is not touched.** The user's call. Changes is coupled to the composer because it *is* the commit surface: the message editor below it is part of the same gesture, so its bottom edge belongs on the entry region rather than on Z2. It keeps its wrapper, its `shadeAnchor="bottom"` against that wrapper, and its cover of Z2 and PULSE. Nothing else has that tie-in, so nothing else pays for it. [D117], [P17].

**[B04] Choose Session and Compacting are exempt and are not touched.** The user's call. Both stand where there is no transcript behind them — the cold-start picker before a session exists, and the cover of a compaction run — so a rise from Z2 would be a motion with nothing to reveal. They keep the top anchor.

**[B05] History takes `shadeAnchor="bottom"`.** Its wrapper is already `.session-view-slot`, so the anchor resolves with no measurement and no new JS; the mirrored CSS geometry and roll transform already exist ([F01]). `shadeAutoSize` stays — the content still owns the height, it simply grows the other way. The stale comments in `session-card.css:130` and `picker-sheet-anchor.ts:6` become true rather than aspirational.

**[B06] The thirteen remaining panel sheets take the anchor and the `rise` entrance.** `bottomAnchorSelector` set to the [B02] constant, and `presentation: "rise"` so the entrance is the short fixed settle rather than a full-height sweep — matching AI Model Settings, which is the one sheet that already reads correctly. The `rise` docstring already names this case ("the Z4B pickers above Z2"); the case is now every sheet.

**[B07] The attachment preview needs a north handle before it moves.** Real work, not a flag flip ([F07]): `SheetResizeEdge` gains `"n"`, `"ne"`, `"nw"` and drops or keeps the south set as the bottom-anchored geometry requires, and the drag math mirrors. If that mirror does not land cleanly, the preview stays top-anchored and is added to the exception list rather than shipped half-moved — a resizable panel whose handle grows it off the card is worse than one that drops from the title bar.

**[B08] `TugAlert` comes off centre onto the rest line.** Same anchor, same entrance. It is a decision surface in a card like any other.

**[B09] Nothing outside the Session card is in scope.** `TugModalInputDialog` (`tug-modal-input-dialog.css:63`, `top: 22vh`) backs Open Quickly, which is canvas-level rather than card-level. `TugPaneBanner` pins under the title bar deliberately — a persistent error strip, not a presentation. Popovers, confirm popovers, context menus and popup lists are trigger-anchored and already flip by available space. The top-right transient-notice host is a corner toast lane. None of these move.

**[B10] The rule gets written down.** [B01] and its three exceptions land in `tuglaws/` beside the existing shade doctrine — a surface-geometry rule the next sheet's author reads before choosing an anchor, so this brief is not re-derived one call site at a time.

---

## Open Questions {#open-questions}

**[Q01] Does the north-handle mirror land cleanly?** [B07] is the only item with real implementation risk. Decide it by attempting the mirror, not by planning around it.

**[Q02] Does `xl` still fit above Z2?** The Help sheet is `displayWidth: "xl"` and Rewind/Usage/Agents/Skills/Hooks/Permissions/Resume are `lg`. The bottom-anchor effect already handles the overflow case — when the panel needs more height than the band, it slides the clip's bottom edge down past the anchor rather than letting the panel ride up under the title bar (`tug-sheet.tsx:1090`, and the `tug-sheet.css:99` comment). Worth confirming that the tallest of these lands on the band rather than routinely overflowing it, since a sheet that always overflows has taken the anchor in name only.

**[Q03] Is the `session-card` shade `persistKey` still right?** History and Changes share `persistKey="session-card"`, so they share a persisted height fraction. Both are `shadeAutoSize`, which ignores the fraction, so this is inert today — but it is a shared key across two surfaces that now differ in anchor, and worth a look while the file is open.

---

## Work {#work}

1. Rename and re-document the anchor constant ([B02]).
2. History: one prop ([B05]); correct the two stale comments ([F03]).
3. The thirteen sheets: anchor + `rise`, one pass ([B06]).
4. `TugAlert` off centre ([B08]).
5. Attempt the north-handle mirror; ship the preview or exempt it ([B07], [Q01]).
6. Write the rule into `tuglaws/` ([B10]).

Exempt throughout, and not to be touched: **Changes**, **Choose Session**, **Compacting**.
