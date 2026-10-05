# Settle-window commit readings

Taken on unbound session cards with empty transcripts: a reading of the chrome, not of a session card (`briefs/real-transcript-motion-brief.md` [F04]).

The readings behind the work that makes each settle gesture's in-window React commit small. Each entry is pasted as the instrument printed it — `tugtool deck motion settle --json` excerpts, or `at0684-settle-window-commits.test.ts`'s `note()` lines — with its date, the tree it was read on, and the deck's census. Numbers here come from a tool, never from a hand.

The file was numbered `at0683` when these readings were taken and was renumbered `at0684` before landing, because `main` gave `at0683` to `at0683-arc-row-join.test.ts` the same day; the notes below carry the new number.

The instruments:

- `at0684-settle-window-commits.test.ts`, in the app-test harness (a debug build, test mode, where the commit census in `tugdeck/index.html` walks every commit). Each leg drives its gesture through `window.tugdeck.lab.drive` and notes every commit from the last armed `settle-arm` to the `settle-frames` row, 60 ms either side; the switch, which arms no settle, is read over the 600 ms from the drive.
- `tugtool deck motion settle --gesture <g> --tasks`, on a release deck, through the same door.

A `why` entry is `Name@<id>{keys}`: a bare key moved in value, a `~key` moved in identity only (which a by-value memo comparator forgives), and `[state/ctx]` means a hook, not a parent, asked. The `<id>` is the component's `activeCardId` where it has one, so a pane reads by its card id.

## Reading 1

### The harness

2026-10-03, at the arc's tip `4df991745` with the fixture census and `at0684` on top (the tree this entry's round commits). `just app-test-build`, then `just app-test at0684-settle-window-commits.test.ts` alone: `VERDICT: PASS (1/1 files green; 5/5 tests passed)`. Fixtures: `close` and `split` on the eight-card shared-column deck, `rails` on the four-up deck with two rails, `unfold` on the four-up flow deck, `switch` on two workspaces of a rail, three session cards and two text cards each.

The windows:

```
at0684 close: 18 commit(s) in a 687 ms window (±60 ms)
at0684 rails: 23 commit(s) in a 698 ms window (±60 ms)
at0684 split: 4 commit(s) in a 438 ms window (±60 ms)
at0684 unfold: 15 commit(s) in a 322 ms window (±60 ms)
at0684 switch: 7 commit(s) in a 600 ms window (±60 ms)
```

The largest commit in each:

```
at0684 close largest: t=16 performed=1676 mounted=107 fibers=2965 origins=[["PopperAnchor",13],["Popper",5],["TugActionTooltip",2],["TugTooltip",2],["Tooltip",2],["DeckCanvas",1],["TugConfirmPopover2",1],["TugPopover2",1],["Popover",1],["PopoverProvider",1],["TugPopoverContent2",1],["TugPopoverAnchor",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c8{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c8{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c7{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c7{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c6{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c6{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c5{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c5{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c4{~sizePolicy,~placement,slotStack}","TugPaneImpl@at0622-c4{~stackState,~sizePolicy,~placement,slotStack}","CardTitleBar2@at0622-c4{slotStack,placeArrangement}"]
at0684 rails largest: t=33 performed=4199 mounted=3787 fibers=4610 origins=[["TugTooltip",12],["Tooltip",12],["PopperAnchor",8],["Popper",6],["TugActionTooltip",6],["TugPopover2",4],["Popover",4],["PopoverProvider",4],["TugPopoverContent2",4],["CardTitleBar2",2],["TugConfirmPopover2",2],["TugPopoverAnchor",2]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c4{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c4{~sizePolicy,zIndex,~placement,~slotStack}","CardTitleBar2@at0622-c4[state/ctx]","CardSlotBadge2@at0622-c4[state/ctx]","TugPaneImpl@at0622-c3{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c3{~sizePolicy,zIndex,~placement,~slotStack}","CardTitleBar2@at0622-c3[state/ctx]","CardSlotBadge2@at0622-c3[state/ctx]","TugPaneImpl@at0622-c2{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c2{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c1{~sizePolicy,zIndex,~placement,~slotStack}"]
at0684 split largest: t=33 performed=854 mounted=6 fibers=1477 origins=[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c2{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","TugPaneImpl@at0622-c2{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","CardTitleBar2@at0622-c2{~slotStack,placeArrangement}","TugPaneImpl@at0622-c1{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","TugPaneImpl@at0622-c1{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","CardTitleBar2@at0622-c1{~slotStack,placeArrangement}"]
at0684 unfold largest: t=12 performed=210 mounted=0 fibers=398 origins=[["ConfigureTug",1],["DeckCanvas",1],["SessionProjectPicker",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c1{stackState,sizePolicy,~placement,~slotStack,folded}","TugPaneImpl@at0622-c1{stackState,sizePolicy,~placement,~slotStack,folded}","CardTitleBar2@at0622-c1{~slotStack,~placeArrangement,folded}"]
at0684 switch largest: t=35 performed=1026 mounted=6 fibers=2265 origins=[["CardsContent",2],["DeckCanvas",1],["TugSheetContent",1]] why=["LayerPanes2@at0684-two{shown,~deck,arr}","LayerPanes2@at0684-one{shown,arr}"]
```

Beside the largest, the rest of each window as the notes printed it, one line per commit (`t`, performed, mounted, fibers, top performers):

- `close`: after the 1676 at t=16, a tooltip tree at t=22 (463 performed, `TugTooltip`×22) and again at t=43 (450); a 184-fiber mount at t=27 (183 mounted); the departing card's own pane at t=41 (`TugPaneImpl@at0622-c4{sizePolicy,…}`, 40 performed); and five small popover-button commits (86–97 performed) through t=74.
- `rails`: after the 4199 at t=33, small commits only — popover buttons (95 performed, 15 mounted at t=111) and a combo box (4 at t=200).
- `split`: after the 854 at t=33, the Layout card at t=48 (691 performed, 52 mounted; `PlaceMark2`×40, `LayoutMiniature`, `LayoutPlaces`), whose `why` is empty because none of its components is on the watched list.
- `unfold`: after the 210 at t=12, the unfolded card's picker sheet mounting at t=33 (158 performed, 157 mounted) and a run of small popover and dialog commits (2–112 performed) through t=160.
- `switch`: after the 1026 at t=35, three more commits of 992–1010 performed at t=39, 62 and 65, each topped by `TugButton2`×52, `TugListRow2`×32 and `TugEditorContextMenu`×40 — the Workspaces card's rows — with an empty `why`.

### The release deck

Not taken. `./tugrust/target/debug/tugtool deck motion settle --gesture rails --count 1 --instance release-main`, 2026-10-03, refused at its rest check before driving anything:

```
deck: 29648 elements, 2189 stacking contexts, 9421 render-layer candidates
      15 pane(s); largest: Overview 8356, tug/kingly-ibis^arc-verb-row3/6 4503, tug/jaunty-coot^settle-window-commit3/9 3501, tug/ritzy-tube 2388, tug/goodly-ferry 1712
at rest: 27 update(s)/s against a budget of 10
error: the deck is not at rest (at rest: 27 update(s)/s against a budget of 10); a settle read over a busy deck is not the gesture's — find what is running with `deck motion list`
```

That deck is the user's working deck, with live arc sessions on it, and it is a release build of `main`: it predates `window.tugdeck.lab.drive` and the census's `mounted` count, so past the rest check the verb would refuse its first drive anyway. Taking this reading means building a release of this arc's tree in place of the installed app and rearranging a quiet deck to each leg's shape, and both of those are the user's to choose. So the release reading waits on a release build that carries the arc, and the harness reading above stands as reading 1.

### Causes, one line per leg

- **close** — every survivor re-renders on a value move of its own `placement` (c5–c8) or `slotStack` (c4), and the survivors' title bars (`CardTitleBar2@…{slotStack,placeArrangement}`) with them. The origins are popover anchors and tooltips (`PopperAnchor`×13): each survivor's rollup popover tree re-renders inside the window, which is most of the 1676.
- **rails** — showing the rail mounts its contents inside the window: 3787 of the 4199 performed fibers are mounts. Beside them every flow pane re-renders for `zIndex` (a value move), and each flow card's `CardTitleBar2` and `CardSlotBadge2` for `[state/ctx]`.
- **split** — the two cards whose column divides re-render for `columnMember` and `columnMode` (the gesture's own content) and their title bars for `placeArrangement`; the Layout card's miniature re-renders in a second commit of 691.
- **unfold** — the largest commit is the unfolding pane itself (`stackState`, `sizePolicy`, `folded`), 210 performed, small. What the window adds is the picker sheet mounting (157 mounted at t=33).
- **switch** — both layers' `LayerPanes` render (`shown` flips; `arr` moves on both, `deck` only in identity on the arriving one) and no `TugPaneImpl` of either layer appears in `why`. The large commits are the Workspaces card's list (`CardsContent` as origin), re-rendering three to four times inside the window at about 1000 fibers each.

## Reading 2

### The harness

2026-10-03, on the arc's tip `e28482677` with the canvas's narrowed deck read (`canvasDeckEqual`, which drops only a commit that moves `hasFocus`), the two pane controllers on selectors, and `at0684`'s new clause on top. `just app-test-build`, then `just app-test at0684-settle-window-commits.test.ts at0622-deck-settle-frames.test.ts`: `VERDICT: PASS (2/2 files green; 13/13 tests passed)`. Same fixtures as reading 1.

```
at0684 close: 18 commit(s) in a 688 ms window (±60 ms)
at0684 rails: 23 commit(s) in a 706 ms window (±60 ms)
at0684 split: 4 commit(s) in a 437 ms window (±60 ms)
at0684 unfold: 15 commit(s) in a 307 ms window (±60 ms)
at0684 switch: 7 commit(s) in a 600 ms window (±60 ms)
```

The largest commit in each:

```
at0684 close largest: t=20 performed=1676 mounted=107 fibers=2965 origins=[["PopperAnchor",13],["Popper",5],["TugActionTooltip",2],["TugTooltip",2],["Tooltip",2],["DeckCanvas",1],["TugConfirmPopover2",1],["TugPopover2",1],["Popover",1],["PopoverProvider",1],["TugPopoverContent2",1],["TugPopoverAnchor",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c8{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c8{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c7{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c7{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c6{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c6{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c5{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c5{~sizePolicy,placement,~slotStack}","TugPaneImpl@at0622-c4{~sizePolicy,~placement,slotStack}","TugPaneImpl@at0622-c4{~stackState,~sizePolicy,~placement,slotStack}","CardTitleBar2@at0622-c4{slotStack,placeArrangement}"]
at0684 rails largest: t=42 performed=4063 mounted=3470 fibers=4610 origins=[["PopperAnchor",8],["TugTooltip",6],["Tooltip",6],["Popper",5],["TugActionTooltip",3],["TugPopover2",2],["Popover",2],["PopoverProvider",2],["TugPopoverContent2",2],["ConfigureTug",1],["DeckCanvas",1],["CardTitleBar2",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c4{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c4{~sizePolicy,zIndex,~placement,~slotStack}","CardTitleBar2@at0622-c4[state/ctx]","CardSlotBadge2@at0622-c4[state/ctx]","TugPaneImpl@at0622-c3{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c3{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c2{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c2{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c1{~sizePolicy,zIndex,~placement,~slotStack}","TugPaneImpl@at0622-c1{~sizePolicy,zIndex,~placement,~slotStack}"]
at0684 split largest: t=28 performed=854 mounted=6 fibers=1477 origins=[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c2{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","TugPaneImpl@at0622-c2{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","CardTitleBar2@at0622-c2{~slotStack,placeArrangement}","TugPaneImpl@at0622-c1{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","TugPaneImpl@at0622-c1{~sizePolicy,~placement,~slotStack,columnMember,columnMode}","CardTitleBar2@at0622-c1{~slotStack,placeArrangement}"]
at0684 unfold largest: t=13 performed=210 mounted=0 fibers=398 origins=[["ConfigureTug",1],["DeckCanvas",1],["SessionProjectPicker",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c1{stackState,sizePolicy,~placement,~slotStack,folded}","TugPaneImpl@at0622-c1{stackState,sizePolicy,~placement,~slotStack,folded}","CardTitleBar2@at0622-c1{~slotStack,~placeArrangement,folded}"]
at0684 switch largest: t=29 performed=1026 mounted=6 fibers=2265 origins=[["CardsContent",2],["DeckCanvas",1],["TugSheetContent",1]] why=["LayerPanes2@at0684-two{shown,~deck,arr}","LayerPanes2@at0684-one{shown,arr}"]
```

An earlier run on the same tree, red on the first form of the new clause, served the close's largest as `t=19 performed=396`, with the popover and tooltip trees in commits of their own at t=24 (463) and t=54 (450). The 1676 is those trees landing in the same commit as the survivors' re-render. So the close's largest is one commit or three depending on scheduling, and the sum is what a cut to the close has to move.

The release-deck reading is not taken, for reading 1's reason.

### Against reading 1, one line per leg

- **close** — 1676 performed against 1676: unchanged. The survivors still re-render for a value move of `placement` (c5–c8) and `slotStack` (c4), and c4 again for `[state/ctx]` at t=45. Every one of those panes is the gesture's own, so the new clause holds.
- **rails** — 4063 performed, 3470 mounted, against 4199 and 3787: the same commit, within a run's variance in how much of the rail mounts in it. Every flow pane still re-renders for `zIndex`.
- **split** — 854 against 854: unchanged.
- **unfold** — 210 against 210: unchanged.
- **switch** — 1026 against 1026: unchanged, with no `TugPaneImpl` in any `why`.

That is what the selector was expected to do: no settle gesture moves only `hasFocus`, so narrowing the canvas's read saves no settle-window commit. The controller selectors save effect runs inside the canvas's render, not renders. Every bare key in reading 1's `TugPaneImpl` entries is on a pane whose box or slot the gesture moved — c5–c8's `placement` and c4's `slotStack` on the close, every flow pane's `zIndex` on the rail show, c1–c2's `columnMember` on the split, c1's fold on the unfold. None is a fact moving on a pane the gesture left alone, so no pane prop moved into a subtree in this round. What is left is the survivors' badge index and count on the close, the rail's mount on the show, and the Workspaces list on the switch.

## Reading 3: the close, with the badge reading its own place

2026-10-03, on the arc's tip `04c3370ef` with the column badge reading its place's count, band and picker rows from the deck (`pane-place-facts.ts`, `CardPlaceBadge` in `tug-pane.tsx`) and the frame's `data-stack-depth` written from the deck, so neither `slotStack` nor the badge's index and count is a pane prop. `just app-test-build`, then `just app-test at0684-settle-window-commits.test.ts at0347-stack-badge-picker.test.ts at0622-deck-settle-frames.test.ts`. `at0684` and `at0347` green; `at0622-deck-settle-frames` red once in that batch on its appear leg's lead (23 ms against 17 ms) and green alone twice after. The core tier: `VERDICT: PASS (19/19 files green; 42/42 tests passed)`.

```
at0684 close: 19 commit(s) in a 676 ms window (±60 ms)
at0684 close largest: t=14 performed=1626 mounted=109 fibers=2983 origins=[["PopperAnchor",15],["Popper",7],["TugPopupMenu",5],["TugActionTooltip",2],["TugTooltip",2],["Tooltip",2],["CardPlaceBadge2",2],["DeckCanvas",1],["TugConfirmPopover2",1],["TugPopover2",1],["Popover",1],["PopoverProvider",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-c8{~sizePolicy,placement}","TugPaneImpl@at0622-c8{~sizePolicy,placement}","TugPaneImpl@at0622-c7{~sizePolicy,placement}","TugPaneImpl@at0622-c7{~sizePolicy,placement}","TugPaneImpl@at0622-c6{~sizePolicy,placement}","TugPaneImpl@at0622-c6{~sizePolicy,placement}","TugPaneImpl@at0622-c5{~sizePolicy,placement}","TugPaneImpl@at0622-c5{~sizePolicy,placement}"]
```

The run before it on the same tree noted the largest commit's first origins with their hooks:

```
hooks=["ConfigureTug hooks[… 6:{cards,panes,activePaneId,imposition} …]","LayoutContent hooks[… 39:{bandPx,stripPx,slots} …]","SessionProjectPicker hooks[0:{options,resolve,callId} …]","CardPlaceBadge2 hooks[6:{slotStack,index,count} 7:{tag,create,deps,inst}]","CardPlaceBadge2 hooks[6:{slotStack,index,count} 7:{tag,create,deps,inst}]"]
```

### Against reading 2

- **close** — 1626 performed against 1676. No survivor's `CardTitleBar` appears in the window's `why` any more (reading 2: `CardTitleBar2@at0622-c4{slotStack,placeArrangement}`), and c4's frame no longer renders for `slotStack`: every survivor `TugPaneImpl` entry now moves `placement`, `sizePolicy` or `stackState` and nothing else. Two badges render, on the panes whose place changed, for `{slotStack,index,count}`.
- The largest commit barely moved because the survivors' bars were never most of it. What asks in it now is the Layout card's miniature (`LayoutContent`, whose snapshot read moves `{bandPx,stripPx,slots}` on every arrangement change), `ConfigureTug` on the whole deck, the newcomer's `SessionProjectPicker`, and popover and tooltip trees whose anchors re-render for a context (`PopperAnchor … ctx[0:ctx]`). None of those is a pane frame or a title bar.

## Reading 4: the rail show, with a hide that parks

2026-10-03, on the arc's tip `86eec759f` with a rail hide that PARKS its members — the side's memory names them, their panes and cards stay on the deck, the frames stay mounted at their pinned boxes with `data-rail-parked` (hidden, `inert`, out of `SHOWN_PANE_FRAMES`, their loops paused) — and a show that clears the memory in one reimpose. `just app-test-build`, then `just app-test at0684-settle-window-commits.test.ts`: `VERDICT: PASS (1/1 files green; 5/5 tests passed)`, with the rails leg now holding that the hide parks the same frames, the show mounts nothing, the same `data-pane-id`s stand after it, and the Window menu marks the members unshown while parked and shown after.

```
at0684 rails: 2 commit(s) in a 682 ms window (±60 ms)
at0684 rails largest: t=23 performed=45 mounted=0 fibers=202 origins=[["ConfigureTug",1],["DeckCanvas",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@at0622-l1{~sizePolicy,sidebarStack,railParked}","TugPaneImpl@at0622-l1{~sizePolicy,sidebarStack,railParked}","TugPaneImpl@at0622-j1{~sizePolicy,sidebarStack,railParked}","TugPaneImpl@at0622-j1{~sizePolicy,sidebarStack,railParked}","TugPaneImpl@at0622-c4{~sizePolicy,zIndex,~placement}","TugPaneImpl@at0622-c4{~sizePolicy,zIndex,~placement}","TugPaneImpl@at0622-c3{~sizePolicy,zIndex,~placement}","TugPaneImpl@at0622-c3{~sizePolicy,zIndex,~placement}","TugPaneImpl@at0622-c2{~sizePolicy,zIndex,~placement}","TugPaneImpl@at0622-c2{~sizePolicy,zIndex,~placement}","TugPaneImpl@at0622-c1{~sizePolicy,zIndex,~placement}"]
```

### Against reading 2

- **rails** — 45 performed, 0 mounted, against 4063 performed and 3470 mounted. The commit is the two rail frames taking their seat back (`sidebarStack`, `railParked`) and every flow pane its new `zIndex`; nothing under them renders.

### What it took, beyond not closing

Each of these was a mount the first parking build still paid at the show, read off the census one at a time:

- **The rail frames' title bars.** A parked frame is in no rail, so it handed its bar no badge arrangement and a width control instead; the show took both back. A parked frame now hands its bar the seat it last stood at, and keeps its one rail edge rather than a free pane's eight.
- **The badges.** A parked member read as standing in no place (count 0); its badge now reads the seat it would stand in.
- **The Layout card**, itself a rail member, redrew its miniature and preview layers over a rail set that had changed under it (874 mounted). While parked its deck readings hold their last standing value, and the show restores an imposition equal by value to the one before the hide — clearing the memory now removes the key rather than writing `hidden: undefined` — so it renders nothing.
- **The canvas's rail chrome** — the rail's shadow, its seam, the vacancy held open opposite it — is drawn for a parked rail too, from the rails the deck would stand, hidden with `data-rail-parked` and without `data-vacant-rail`, so the drop-zone engine never reads it.

The release-deck check (`tugtool deck motion list` on a deck with a parked rail) is not taken, for reading 1's reason: the installed release is a build of `main`, with no parking in it.

## The switch: nothing to keep

Readings 1 and 2 both put no `TugPaneImpl` of either layer in the `switch` leg's `why`: both `LayerPanes` render — `shown` flips, `arr` moves on both, `deck` only in identity on the arriving one — and stop there. The departing workspace's panes already commit nothing, so keeping its deck object through the re-solve would save no fiber in the window, and `_resolveShownArrangement` is left as it is. What the switch does pay is the Workspaces card's list (`CardsContent` as origin), re-rendering three to four times at about 1000 fibers each with an empty `why` — a cost of that card, not of the deck's identity, and outside this arc.

## Reading 5: the bar's readings

2026-10-03, at the arc's tip `2a9b8dcab`, `just app-test-build` and then `at0684` alone six times: three before the bar and three with it, every run `VERDICT: PASS (1/1 files green; 5/5 tests passed)`. Largest in-window commit per leg, in fibers performed:

| leg | runs 1–6 | mounted |
|-----|----------|---------|
| close | 1626, 547, 547, 1626, 1626, 547 | 109 / 3 |
| rails | 45 every run | 0 |
| split | 858 every run | 6 |
| unfold | 169 every run | 0 |
| switch | 1026 every run | 6 |

The close is the one leg with two readings, and they are the same work: at 1626 React has batched the close's own commit (about 30) with the badge commit (547) and the tooltip commit (450) that land apart at 547. The release-deck half of this reading is not taken, for reading 1's reason: the installed release is a build of `main`.

`at0684` does not use `installLeadRecorder`, so there is no `react_ms` to bar.

**Decided, as the arc's default, for the user to revise:** each leg's largest in-window commit is under about a quarter's headroom over the largest seen alone — close 2000, rails 100, split 1100, unfold 250, switch 1300 fibers performed. The brief makes the number the user's call; the arc does not stop for it, so this is the default the bar lands with, and changing it is one table (`COMMIT_BAR`) in `at0684`. The rails bar is the one with teeth against what this arc removed (4063 before); the others hold each leg near where it stands.

## Reading 6: the bar at the fixed tree

2026-10-04, at `1d9221e70`, with every driven gesture under the click's `pointer` hold (`driveGesture` opens it before it dispatches or closes) and the store publishing the standing deck. `at0684` alone three times, every run `VERDICT: PASS (1/1 files green; 5/5 tests passed)`. Largest in-window commit per leg, in fibers performed:

| leg | runs 1–3 | bar |
|-----|----------|-----|
| close | 1623, 547, 547 | 2000 (unchanged) |
| rails | 45, 45, 45 | 57 (was 100) |
| split | 858, 858, 858 | 1075 (was 1100) |
| unfold | 169, 169, 169 | 212 (was 250) |
| switch | 1026, 1026, 1026 | 1285 (was 1300) |

The close is reading 5's two readings again: 1623 when React batches the close's own commit with the badge and tooltip commits, 547 when they land apart. Departing-and-height's reading 1 put it at 580, the apart case. A quarter over 1623 would loosen the close's bar, so it stays at 2000; every other bar is set to about a quarter over its reading and is tighter than before. The three readings stand beside each bar in `COMMIT_BAR`'s comment, so revising a number is one table.
