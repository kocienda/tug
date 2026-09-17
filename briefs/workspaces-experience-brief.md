<!-- brief-skeleton v1 -->

# The Workspaces card's second pass: a delete that crashes, three levels that read as one, and a switch that blinks

**Purpose:** Seven reports against the Workspaces card and the workspace switch, gathered from using the landed surface. One is a crash that loses the deck. Two are about what the card's three levels look like. Three are small corrections to the card's verbs and its rows. The last is the switch itself, which cuts to an empty canvas and fades the new workspace in, because the settle reads every pane on both sides of a switch as an arrival or a departure.

---

## Purpose {#purpose}

The user, after the `workspaces-press-and-mark` and `content-visibility-audit` arcs landed (`601e7db9e`, `a04ae1f7a`), with the surface in front of them:

> - The confirm-popover on the *delete workspace* feature should point to the workspace header/row
> - Deleting a workspace doesn't actually work: [a red error banner reading `undefined is not an object (evaluating 't.type')` over a stack trace, with a RELOAD button]
> - The workspace header/row in the Workspaces card should be the one with the darker coloration, rather than Sessions and Files below. The icon/label/summary content for the workspace header/row should be the leftmost-indented content in the card. Right now, Sessions and Cards are actually not indented *under* its workspace header properly.
> - There should be no *New Workspace* option in the `···` menu for workspace. Those commands should only apply to the workspace itself. The `+` menu to the right of the row that includes *Filter Workspaces* on the left becomes the only in-card means to add a new workspace. That's fine.
> - The workspace header/row should grow in height so that when the user selects *Rename* for the workspace, that the row does not need to grow in height to accommodate the editing field.
> - Empty workspaces should get a "None" row when they are empty, both to match other cards (and take care that the style you use matches the one we use for other cards), and to give more of a drop zone when the user wants to drag a card into an otherwise empty workspace.
> - The transition between workspaces should be better. Now, we fade to a blank deck/canvas, and then fade in the new cards. This is distracting. We should instead do one smooth crossfade without the blank deck/canvas in the middle.

Seven items of very different weight. The second takes the whole deck down and is the only one the user cannot work around; it is also the only one that did not yield to investigation. The seventh is the only one whose fix reaches outside this card. The other five are the card's own presentation and verbs, and every one of them was settled by reading the code.

---

## Evidence {#evidence}

### The delete crash

**[F01] The delete confirm and the walk behind it are correct as far as the store; the throw is downstream of it and could not be reproduced** — `cards-card.tsx`'s `runGuardedDelete` activates the workspace, walks every card's close guard, and calls `store.deleteSpace(spaceId)`; `DeckManager.deleteSpace` swaps the active workspace to a neighbour, closes unbound sessions, fires `notifyCardWillBeginDestruction` for every card, and splices the record out. Three throwaway app-test probes drove the real `···` → Delete → confirm with a `window.onerror` recorder armed, and all three came back with zero errors and the workspace gone: a **parked** workspace holding a clean Text card, the **active** workspace holding the same, and a workspace holding an unbound **Session** card. The user's own case differs in holding two *bound* session cards. **(verified that it did not reproduce; the shapes tried are listed so the next attempt starts past them)**

**[F02] The throw's text names a read the Workspaces card does in six places with no guard, and the compiler cannot see it** — the banner reads `undefined is not an object (evaluating 't.type')`. `CardsDataSource.rowAt(index)` is declared to return `CardsRow` and its body is `return this.rows[index]`, which is `CardsRow | undefined` in fact; `tugdeck/tsconfig.json` sets `strict` but not `noUncheckedIndexedAccess`, so the declaration stands unchallenged. Six of the ten call sites then read `row.type` immediately — the group-header cell, the session cell, the files cell, two registration cells, the subrow cell, and `SpaceHeaderCell` — and only two (`cards-card.tsx:1412` and `:1455`) test for `undefined` first. A cell rendered against an index the projection no longer holds throws exactly this. **(verified, read out of the code)**

**[F03] The stack under the banner is a synchronous store notification inside the teardown** — the frames read, innermost out: `setKeyView` ← `popFocusMode` ← `notify` ← `notifyChange` ← `touch`, with React frames above them. So a focus mode is being popped during the delete, its pop writes a key view, and that write notifies subscribers synchronously — which is a render of the Workspaces card's list in the middle of `deleteSpace`, before the record has been spliced out or after it has, but in either case not at a moment the list's own cell indices were computed for. That is the shape `[F02]` turns into a throw. **(verified that this is the stack; that it is the cause is inference, and `[F01]` is why it is still inference)**

### The card's three levels

**[F04] The workspace header is the *lighter* of the two header levels, not the darker** — `cards-card.css` washes both by mixing the normal text colour into the card's well: `--tugx-group-header-wash` at 9% for a group header, `--tugx-space-header-wash` at 16% for a workspace header. On a dark theme the text colour is the light one, so a larger share is a lighter row, and the outermost level is the brightest thing in the list. The rule's own comment says so — "one surface step ABOVE the group header's wash". **(verified, read out of the code)**

**[F05] The three levels share one leading inset, so nothing is indented under anything** — `SpaceHeaderCell` and the group-header cell both render their contents inside `.cards-header-line`, whose only leading rule is `padding-inline-start: var(--tugx-group-header-inset)` — 4px, for the movement caret. The pane rows take the same nudge through `--tugx-session-row-leading-inset`, also 4px. The one indent step that exists in the file is `.cards-subrow`'s 20px, which marks a card inside a multi-card pane. So the workspace's eye, the group's glyph and a session row's dot all stand in the same column. **(verified, read out of the code; matches the user's screenshot, where the three glyphs are flush)**

### The row menu and the rename field

**[F06] The `···` menu's first item is a verb about no workspace in particular, and the card already has a door for it** — `useSpaceRowMenu` builds four items, and the first is `New Workspace` with an empty `value`; its own comment concedes the payload is "harmless" rather than meaningful. The other three carry `{ spaceId }` and act on the row they were opened from. Meanwhile the card's toolbar already renders a `+` button beside the filter field dispatching the same `new-space` (`data-testid="cards-new-space"`), which `at0582-workspace-doors` exercises. The four-item list is asserted twice in `at0582` and, separately, by `at0586-window-workspace-verbs` for the **Window menu** — a different surface, where a global New Workspace does belong. **(verified, read out of the code and the tests)**

**[F07] The rename field is taller than the row it opens in** — `SpaceRenameField` renders `TugInput` at `size="sm"`, which `tug-input.css` fixes at `1.75rem` (28px). The workspace header keeps the list row's default `--tugx-list-row-padding-block: 8px` — the 2px dense metric is scoped to `.cards-oneline` and does not reach it — so the row at rest is its tallest resting member plus 16px, and with the field open it is 28 plus 16. Nothing in `cards-card.css` sets a floor on the header's height. So the row grows when the field opens and shrinks when it commits, and every row below it moves twice. **(verified by arithmetic over the two rules; the exact pixel delta was not measured in the running app)**

### Empty workspaces

**[F08] An empty workspace projects its header and nothing else** — `buildSpaceRows` walks the groups and `continue`s past any whose bucket is empty, and past any whose survivors are empty after a filter, so it emits no group header and no pane row. `buildCardsRows` pushes the `space-header` unconditionally, on the stated ground that "a place that disappeared while the user was typing would read as a place that is gone". So an empty workspace is one row tall. The cross-workspace drop target is the `data-cards-space-run` block (`cards-card.css`), which for such a workspace is that single row — the thin target the user is aiming at. **(verified, read out of the code)**

**[F09] The house's empty label is a stand-in for a whole list, not a row inside one** — `.cards-empty` and `.jots-empty` are the same rule written twice: centred, 12px, subtle tone, `min-block-size: 28px`, rendered *instead of* the list when it has nothing. Both cards also distinguish `"None"` from `"No matches"`, the second meaning the filter is hiding what is there. There is no existing precedent for an empty label **inside** a list, under one section of it. **(verified, read out of the code)**

### The switch

**[F10] Nothing animates a workspace switch, and that is why it looks animated** — `DeckManager.activateSpace` swaps the deck, restores sessions and moves focus, with no motion anywhere in it; `space-layer.css` is two rules, `display: none` and `display: contents`. The transition the user sees is the canvas settle misreading the swap. `SHOWN_PANE_FRAMES` excludes any pane inside a layer without `data-space-shown`, so from the settle's point of view the outgoing workspace's panes vanished from the document and the incoming workspace's panes appeared in it. `deck-canvas.tsx`'s Last pass computes `hasDeparture` from First rects with no survivor and `hasArrival` from survivors with no First rect — both true on every switch — so the settle fuses, mints a **departure ghost** (a blank tile at each outgoing pane's rect) for the workspace being left, and holds every incoming frame at `frame.style.opacity = "0"` for its arrive beat. Blank tiles where the old cards were, then the new cards fading up, is precisely what the user described. **(verified, read out of the code)**

**[F11] A crossfade needs both layers painted, and the hidden rule exists to forbid exactly that** — `space-layer.css` states the reason in full: `display: none` over a visibility or opacity trick so that a hidden workspace "must cost no layout and no paint, and must not be reachable by the pointer", with the acknowledged price that its subtree can take no measurement. Any crossfade puts both workspaces' boxes on the canvas for the duration of the beat. **(verified, read out of the code)**

### The confirm's anchor

**[F12] The confirm is anchored to the right row and cannot show it** — `anchorForSpace` resolves the header's `.tug-list-view-cell` and `TugConfirmPopover` is given it with `side="top"`. `TugPopover` supports an arrow (`arrow?: boolean`, rendering `.tug-popover-arrow`), it defaults to `false`, and **no call site in the app passes it** — so no popover in Tug has ever drawn one. With `side="top"` and a header near the top of a scrolled list, the floating layer flips or shifts the popover to keep it on screen, and it comes to rest over rows belonging to a different workspace with nothing tying it to its own. **(verified, read out of the code; the user's screenshot is the shifted case)**

---

## Decisions {#decisions}

**[B01] The delete crash is found before it is fixed, and the first step is the reproduction.** `[F01]` is three shapes eliminated, not a mystery solved, and `[F02]`'s six unguarded reads are a candidate rather than a cause. The next attempt starts from what the user's case has that the probes did not — two **bound** session cards in the workspace being deleted — and arms the same `window.onerror` recorder. Only once a probe is red does the fix land against it.

**[B02] `rowAt` stops lying, whatever the crash turns out to be.** Its return type becomes `CardsRow | undefined` and all six unguarded call sites take the `undefined` branch, because a cell renderer asked for a row that is gone should draw nothing rather than throw. This is worth doing on its own terms — a data source that promises a row for any integer is wrong about its own array — and it is not to be mistaken for the fix: a list that renders against a stale index is still a defect after the crash stops, and `[B01]` is what finds it.

**[B03] The workspace header becomes the darkest level and the other two step up from it.** `[F04]` has the wash running the wrong way: the container is currently louder than what it contains. The outermost level recedes and the rows the reader is actually working with come forward, which inverts the two wash tokens rather than adding a third mechanism. What the step must not do is trade places with the drop-target wash, which paints the same block.

**[B04] Indent is the card's statement of its three levels, and the workspace header holds the leading edge.** Per `[F05]`, the workspace header keeps the 4px caret inset it has; group headers take one step in from it and pane rows take a second, so a session row's dot starts inboard of its group's glyph, which starts inboard of its workspace's eye. The step is a token of the card's own, stated once, so the three levels cannot drift apart by hand. The 20px subrow step stays what it is — a card inside a pane is a fourth thing and it already reads.

**[B05] The `···` menu holds only verbs about the workspace whose row it opened on.** `New Workspace` comes out, leaving Rename, Duplicate and Delete — three items that all carry a `spaceId` and all mean the row. The `+` beside the filter field is the card's door for making one, and it already exists (`[F06]`), so nothing is lost. The Window menu keeps its New Workspace: it is a global menu with no row to be about, and `at0586`'s four-item assertion is correct there and stays. `at0582`'s two assertions of the row menu become three-item.

**[B06] The workspace header stands at the rename field's height at rest.** A floor on the header row, equal to the height the field needs (`[F07]`), so opening a rename changes what is in the row and never how tall it is. The floor is on the header alone — the group headers and the dense one-line rows keep their own metrics — and it is stated as a token beside the field's size so the two cannot drift.

**[B07] An empty workspace gets a `None` row, which is a real list row.** It wears `spaceRowAttrs`, so it joins its workspace's `data-cards-space-run` block and the drop target grows with it — which is half of why the user asked for it. It takes `.cards-empty`'s voice (`[F09]`): centred, 12px, subtle, the same 28px measure, so an empty workspace reads like an empty Jots card and not like a new invention. And it keeps the same distinction the card already makes one level up — `None` when the workspace holds nothing, `No matches` when a filter is hiding what it holds — because a reader who is typing in the filter field needs to know which they are looking at.

**[B08] A workspace switch is one crossfade, and the settle is told it is not an arrangement change.** `[F10]` is the defect: the switch is currently spelled to the canvas as a mass departure and a mass arrival, and it gets the treatment that spelling earns — ghosts, then a staged fade-up. The switch names itself to the settle instead, and for the duration of one beat both layers are painted and cross-faded as wholes: no departure ghosts, no per-pane arrive beats, no blank canvas between. The panes do not move, so there is no geometry to invert; opacity is the whole of it.

**[B09] The hidden rule stays `display: none` at rest, and the crossfade is a bounded window.** `[F11]` is a real cost and `space-layer.css`'s reasoning still holds: a mounted workspace nobody is looking at must cost no paint and take no pointer. So the outgoing layer is shown-but-inert only while the beat runs and returns to `display: none` when it lands — which means the beat must land, including when it is interrupted by a second switch, and that the inert window is where `useSpaceLayerShown` has to keep telling the truth. A hidden workspace that is permanently painted is the alternative and it is refused.

**[B10] The confirm points at its row.** The popover takes the arrow `TugPopover` already has and no call site has ever asked for (`[F12]`), and the arrow is what carries "this workspace" when the floating layer moves the body somewhere it did not plan to be. Whether the anchor should also be scrolled into view before the confirm opens is `[Q01]`.

---

## Open Questions {#open-questions}

- **Does the confirm need to scroll its row into view as well as point at it?** An arrow answers the case where the row is on screen and the popover has shifted. It answers nothing when the row is scrolled out of the list entirely, which is the state the user's screenshot may have been in — a reader would see an arrow aimed off the edge of the card. Settled by reproducing the delete from a header scrolled out of view and looking at what the arrow does; the fallback is to reveal the row first, which the card can do because it owns the list.
- **Is the arrow this popover's, or every confirm popover's?** `[F12]` found that no confirm in Tug draws one. Making it this call site's prop is the small change; making it the controlled-mode default is the consistent one, and it would change the Arcs card's confirm and every other on the same day. Not this brief's to decide — it is a question for whoever reads `[F12]` against the other call sites.

---

## Non-goals {#non-goals}

- **Fixing the crash by guarding `rowAt`'s six call sites and stopping there.** `[B02]` does the guard because the type is wrong, not because it is the cure. A list rendering against indices its projection no longer has is the defect; a guard makes it silent.
- **A third header level, or a disclosure triangle, to carry the indent.** `[B04]` spends indent and wash, which the card already has. The fold cue is at the trailing edge on every header by `[B02]` of `workspaces-refine`, and moving it back to the leading edge to serve as an indent anchor would undo that.
- **Removing the `···` menu.** `workspaces-refine` `[B01]` put it there on the argument that a verb with no visible door is a verb a person has to already know about, and that argument is untouched by `[B05]`, which only takes out the one item that is not about the row.
- **Keeping hidden workspaces painted so a crossfade is always available.** Refused by `[B09]`.
- **An animated transition for anything else the switch does** — focus landing, sessions restoring, a card's own first-mount entrance. `[B08]` is about the canvas crossing from one workspace to another and nothing else.
- **The eviction or memory policy for mounted workspaces.** Still `[Q01]` of `workspaces-refine`, still deferred.

---

## Exit {#exit}

**An arc.** Three pieces that do not depend on each other, and one order that matters inside the first.

1. **The delete.** The reproduction first, per `[B01]` — a probe with bound session cards in the deleted workspace — then the fix it earns, then `[B02]`'s type correction and its six call sites, then a permanent test in place of the probe. `at0585-workspace-delete-guard` covers only the dirty-card path that ends in a sheet; the clean path that reaches `deleteSpace` directly has no test at all, which is what `[F01]`'s first probe had to write from scratch.
2. **The card's presentation and verbs** — `[B03]`, `[B04]`, `[B05]`, `[B06]`, `[B07]`, `[B10]`. Independent of each other and of the crash. `at0582-workspace-doors`'s two four-item assertions become three-item; the `None` row wants a leg asserting it is a drop target, not just that it is drawn.
3. **The switch** — `[B08]` and `[B09]`. The one piece that reaches outside the Workspaces card, into `deck-canvas.tsx`'s settle and `space-layer.css`, and the one with a standing rule to keep faith with. `at0578-workspaces-switch` and `at0587-workspace-switch-mounted` are where it is pinned; what has to be asserted is that no departure ghost is minted and no pane frame is ever held at `opacity: 0` across a switch.
