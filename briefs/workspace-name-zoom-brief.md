# Workspace naming modal: zoom rectangles on the way in and out, and an empty workspace's `None` in the house voice

**Purpose:** The naming modal New and Duplicate Workspace raise appears and disappears with no sense of where it came from or where its workspace went, and an empty workspace's `None` row renders at body size, left-aligned, unlike every other sidebar card's empty line.

---

## Purpose {#purpose}

Two notes from using the naming modal the `workspace-naming-modal` arc landed:

- "Let's use the same classic macOS *zoom* rects animation to show the new Workspace sheet move to the place in the Workspaces tab where the new workspace will appear. As a bonus, we could show the zoom rects animation right after clicking the `+` button too, meaning it zooms on order-in and order-out."
- "*None* label must be the same style as it is in all other sidebar cards: smaller and centered." The screenshot shows an expanded, empty `Workspace 1` whose `None` sits flush left at full body size under its header row.

---

## Evidence {#evidence}

**[F01] The zoom animation already exists as a reusable module.** `tugdeck/src/components/chrome/zoom-rects.ts` draws classic Mac OS zoom rectangles for the update pill and the `UpdateTug` wizard: `runZoomRects(from, to)` plants ten outline rectangles (`ZOOM_RECT_COUNT`), three up at once (`ZOOM_TRAIL_DEPTH`), eased to bunch at the destination (`ZOOM_EASE_POWER` 1.25), over a 200 ms run (`ZOOM_RUN_DURATION_MS`, mirrored by `--tugx-zoom-run-duration` in `zoom-rects.css`). Only opacity animates, through `tug-animator`. It plants nothing and returns `false` under reduced motion or a zero timing scale, and its layer lives in the canvas overlay root of the page that runs it. A one-slot stash (`stashZoomRect` / `claimZoomRect`) lets a departing side hand its rect to an arriving one. **(verified, read from the code)**

**[F02] The arriving surface hides until the run lands.** `update-pill.tsx`'s `attachPill` ref callback claims the stashed rect, sets `data-zoom` on the arriving element *before* measuring it, runs the rectangles, and removes `data-zoom` if the run declined. A CSS delay keyed on `data-zoom` holds the element's reveal for the run's length. A surface raised with nothing to zoom from (the wizard from the Tug menu or Sparkle) gets no run and no attribute. **(verified)**

**[F03] The `+` and the new workspace's row live in a different web view from the modal.** The Workspaces card (`components/cards/cards-card.tsx`) is a sidebar card in its own body page. The `+` (`data-testid="cards-new-space"`) is a `TugIconButton` dispatching `TUG_ACTIONS.NEW_SPACE` with no payload. Where the host keeps an overlay, the naming modal (`TugWorkspaceNameDialog`, mounted by `AppGates`) draws in the overlay page, which covers the window; the question reaches it as the `overlay.workspaceName` shared store (`bus/declarations/overlay.ts`) relayed from the shell's `lib/workspace-name-request.ts`, and the answer returns as `overlay.workspaceNameAnswer`. A rect measured in a body page is in that page's viewport coordinates and means nothing to the overlay without its card's origin. **(verified)**

**[F04] The shell already holds every card's content box in window points.** `overlay.surfaces` carries, per card id, the card's `body` rect — its content box, which is the body page's viewport — in the coordinates the overlay page draws in. So body-local rect + card origin = overlay rect, and the shell is the one place that can add them. **(verified)**

**[F05] New Workspace's row appears only after the cut, and the cut happens under the scrim.** `lib/new-workspace.ts`: the gesture builds the workspace pending (`DeckManager.beginPendingSpace`, out of the list), and a committed name's settle cuts onto the pages made meanwhile while the modal still stands; then the question closes, the scrim fades, and `cardsSpaceVerbRequest.request("focus", id)` lands the keyboard on the new workspace's header row, at the top of the list (`spaces-store.ts` adopts the pending record at index 0). So the destination row exists, in the newly shown Workspaces card, between the cut and the close. **(verified)**

**[F06] Duplicate does not cut.** The `DUPLICATE_SPACE` handler in `components/chrome/deck-canvas.tsx` asks `askWorkspaceName("duplicate", …)` with no settle, then `store.duplicateSpace(spaceId, name)`, which inserts the copy directly after its source (`index + 1`) without activating it. Its row appears in the Workspaces card already on screen, after the answer. Its doors are the row menus (the `…` on a header) and the Window menu. **(verified)**

**[F07] The empty-workspace `None` lost its voice in the component-library consolidation.** `SpaceEmptyCell` in `cards-card.tsx` renders `<span className="rail-card-empty cards-empty">`. The consolidation (`65742885b`) retired the `.rail-card-empty` rule and moved the empty-line voice into `TugEmptyLine` (`components/tugways/tug-empty-line.tsx`/`.css`: 12px, `--tug7-element-global-text-normal-subtle-rest`, centred, 28px min height, 10px inline padding), converting the card-level empty line in the same file but not this one. No stylesheet now styles `.rail-card-empty`, so the span renders at inherited size, left-aligned. The rule at `cards-card.css` `.cards-space-empty > .cards-empty` already says "the voice is `.tug-empty-line`'s" and only sizes it to the row. **(verified, read from the code; matches the screenshot)**

---

## Decisions {#decisions}

**[B01] The empty-workspace row draws `TugEmptyLine`.** `SpaceEmptyCell` renders `<TugEmptyLine className="cards-empty">` with the same `None` / `No matches` words, inside the existing `.cards-space-empty` wrapper that carries `spaceRowAttrs`. This is the component every sidebar card's empty line uses ([F07]), and the existing `.cards-space-empty > .cards-empty` rule already assumes it. No new style is authored.

**[B02] The naming modal uses `zoom-rects.ts`, not a second animation.** Every run goes through `runZoomRects`, at its existing constants. The update pill and wizard settled the look by eye; a second implementation would drift from it.

**[B03] The run stays 200 ms to start, judged live.** The `+` → panel distance (a ~20pt button to a ~400pt panel) is close to the pill → wizard ratio that 200 ms was settled against. If it reads wrong on the modal, change it there; the constant and its CSS mirror move together.

**[B04] Order-in zooms from the gesture's source to the panel.** When the modal is raised by the Workspaces card's `+`, the rectangles run from the button's rect to the panel's, and the panel is held hidden for the run by the `data-zoom` pattern ([F02]): mark, then measure, then run, and drop the mark if the run declined. Duplicate raised from a header row's `…` menu zooms from that header row. A door with no on-screen origin — the Window menu, a key chord — raises the modal with no order-in run, as the wizard opened from the menu does.

**[B05] Order-out zooms from the panel to the new workspace's header row.** For New, the row is the top row of the Workspaces card shown after the cut ([F05]); for Duplicate, it is the copy's row directly after its source in the card on screen ([F06]). The rectangles run as the scrim fades.

**[B06] The modal closes once the destination is known, bounded.** New's close waits, after the cut, for the newly shown Workspaces card to report its new row's rect — the same moment it already answers the `focus` request — with a short bound; past the bound it closes with no order-out run. Duplicate's card reports the copy's row once it appears, without moving the keyboard there, since Duplicate does not activate the copy. A rect that arrives after the close is dropped. The run is decoration ([F01]); nothing may wait on it beyond the bound.

**[B07] Cancel zooms back to where the modal came from.** Cancel and Escape run the rectangles from the panel back to the order-in source, as a Finder window closed back into its icon. With no source ([B04]) a cancel fades as it does today.

**[B08] No zoom target is invented.** If no Workspaces card stands on screen where the row lands, there is no order-out run and the scrim fades as today; the card is not revealed to give the run a destination. Reduced motion or a zero timing scale plants nothing and sets no `data-zoom` ([F01]).

**[B09] Rects cross pages in window points, converted by the shell.** A body page reports a rect it measured with its card id; the shell adds that card's content-box origin ([F04]) and carries the result on the question. `WorkspaceNameRequest` gains optional `from` and `to` rects in window points, and `overlay.workspaceName`'s codec carries them, so the overlay page runs `runZoomRects` itself. `NEW_SPACE` (from the `+`) and `DUPLICATE_SPACE` (from a row menu) carry the source rect and card id in their payload; the destination arrives on a card-to-shell action. In a page with no host overlay — a plain browser — the modal, the card and the zoom layer share one page and no conversion applies. A superseded question carries neither rect onward.

**[B10] Proven at two layers.** The question store's handling of `from`/`to` — carried, dropped on supersession, closed with no `to` past the bound — is pure logic under unit tests. That the rectangles actually appear between the `+` and the panel, and between the panel and the new top row, and not on a menu-raised New, is an app-test that clicks the real `+` and samples frames, carrying `@covers` for the files it exercises.

---

## Non-goals {#non-goals}

- **Revealing the Workspaces card to land a zoom.** A closed card stays closed; the run is skipped instead ([B08]).
- **A different animation for the modal.** Scaling the panel, sliding it, or a CSS keyframe of its own were not considered worth a second motion vocabulary; the zoom rectangles are the house shape for "this came from there" ([B02]).
- **Changing what New or Duplicate do.** Which workspace is made, where it is inserted, whether it is activated, and how the cut waits on its pages all stay as the naming-modal arc left them; this work only draws between their surfaces.

---

## Exit {#exit}

An arc. The `None` fix ([B01]) is independent and small, and lands first. The zoom then builds outward from the existing module: the question's `from`/`to` and their relay to the overlay ([B09]) with their unit tests; order-in from the `+` and from a row menu ([B04]); the destination report and bounded close for New and Duplicate ([B05], [B06]); cancel's return run ([B07]); and the frame-sampling app-test ([B10]) as the verdict, after which the 200 ms run is judged live ([B03]).
