# An arc row on the Arcs card folds open to its ledger

**Status:** sketch, scope settled 2026-09-04. Ready for `/arc`. The three
calls are recorded under [Decisions](#decisions).

The ask: each arc row in the Arcs card gets an expand/collapse control. Expanded,
the row shows the plan's steps the way the Z2 `ARC` placard already does — the
ordinal, the title, the pulsing-dot state, one row per ledger line.

## The rule

> **The Arcs card row is the placard's reading, folded.** Collapsed, it is the
> two-line `ArcLifecycleBlock` it is today. Expanded, it is that block over the
> same ledger the placard shows, rendered by the same component — so the row,
> the placard, and the shade cannot disagree about one arc's steps.

Nothing new is derived. The step titles and statuses already ride the wire on
every arc entry (`ArcChangesetEntry.steps: ArcStep[]`, `lib/changeset-types.ts:277`)
— the track's ticks are drawn from them now. The Arcs card simply has not been
showing the titles.

## What is already true

- **The block reserved the slot.** `ArcLifecycleBlock`'s docblock says of its
  `trailing` prop: *"The trailing slot is the surface's own — a row menu, a fold
  cue — and rides the eyebrow's end."* (`arc-lifecycle-block.tsx`). The Arcs card
  passes nothing there today; the verbs menu is a context menu with no opener.
- **The ledger renderer exists.** `ArcStepItems` in
  `cards/session-card-telemetry-popovers.tsx:1286` is the numbered list in the
  screenshot: `TugPopupListItem` rows, a `TugProgressIndicator` pulsing dot in
  the lead column, `N.` in tabular muted ink, the title, strikethrough on `done`.
  It is exported and has one importer — the placard.
- **The fold cue exists, and the tool-call header is its canonical home.**
  Every tool block's whole-block fold is one `BlockFoldCue`
  (`body-kinds/affordances/block-fold-cue.tsx`) at the trailing edge of
  `BlockHeader` (`blocks/block-header.tsx:418`): `subtype="icon"`,
  `size="xs"`, `ChevronsDown` to expand / `ChevronsUp` to collapse,
  `aria-expanded`, and the default `stabilizeScroll` — release the host's
  follow-bottom lock, then hold the clicked header's viewport position across
  the height change. The History list carries the same cue on its commit rows.
  This is the machinery; nothing here invents a second fold.
- **A control inside a row does not pick the row.** `TugListView` commits
  selection at pointerdown, and `targetIsRowAction` excuses any descendant that
  refuses focus (`tug-list-view.tsx:6240`) — which every `TugButton`-family
  control does. So a press on the cue never reaches the Arcs delegate's
  `onSelect`, which is the handler that fronts the worker card
  (`arcs-card.tsx:845`). No `stopPropagation` and no new guard.
- **Cells are measured, not assumed.** The list corrects to each cell's true
  height by `ResizeObserver` and its cells are keyed by `idForIndex` — the arc's
  `ownerId` — so a row that grows re-measures and keeps its identity.

## The shape

```
┌─────────────────────────────────────────────────────────────────┐
│  ^rail-promotion ───────────────────────── ● tug/fabled-trout  ⌄ │   eyebrow + cue
│  ▬▬ ▮ ▯ ▯ ▯ ▯ ▭ ▭  ⚒ 1/5 implement                                │   lifecycle line
│                                                                  │
│      ◉  1.  The rail toggle command and its ladder                │   ledger (expanded)
│      ○  2.  Retire the per-card sidebar chords                    │
│      ○  3.  Port the overflow geometry from columns to rails      │
│      ○  4.  Rewrite the doctrine and regenerate the menu tables   │
│      ○  5.  Tests                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Collapsed is line one and line two, exactly as now, with the chevron at the
eyebrow's end. The join register (line three, when there is a join) stays
between the lifecycle line and the ledger: what the arc is doing, then what
its join is doing, then what its plan says.

**The cue.** The tool-call header's disclosure, verbatim, in the block's
`trailing` slot:

```tsx
<BlockFoldCue
  collapsed={!expanded}
  onToggle={(nextCollapsed) => toggle(row.ownerId, !nextCollapsed)}
  collapsedLabel="Expand"
  expandedLabel="Collapse"
  ariaLabelExpand={`Expand ${entry.display_name} steps`}
  ariaLabelCollapse={`Collapse ${entry.display_name} steps`}
  size="xs"
  subtype="icon"
  data-slot="arcs-steps-fold"
/>
```

Same size, same icon pair, same labels, same scroll behaviour as every tool
block in the transcript — `stabilizeScroll` stays at its default, because the
Arcs list is a scrolling host exactly as the transcript is, and a row that
opens beneath the pointer should hold its place the way a tool block does.
The History row's `2xs` / `stabilizeScroll={false}` variant is that list's
own tuning and is not copied here. The chevron sits where the header puts
it: last in the cluster, at the trailing edge, in both states.

**When there is no cue.** An arc with no steps — a brief alone, an arc still in
devise — has nothing to fold, so it draws no cue. Absent, not disabled: a
disabled chevron on a row that will never have steps is a promise about a
future the row does not know. The cue appears the moment the entry carries a
ledger, which is the moment the track grows ticks.

**The ledger.** `ArcStepItems` lifted out of the popovers file into
`components/tugways/arc-step-list.tsx` + `.css`, with the three rules that
make it read as prose carried with it (the ordinal, the `done` strikethrough,
the 22px lead column and sans face the placard sets on
`[data-slot="session-arc-popover-body"]`). The placard imports it from there
and loses its private copy. The `idle` input — which decides whether the
in-progress dot pulses — is `entry.holders_busy !== true` on the card, the
same fact the register already reads.

Indented to `--tugx-session-atom-text-inset`, as `.arcs-register` is, so the
ordinals stand under the atom's text and the dots under its live dot.
`data-slot="arcs-steps"` on the list; each row keeps `ArcStepItems`'s own
`data-slot="session-arc-popover-step"` — renamed to `arc-step` since it no
longer belongs to a popover — and `data-status`.

**No footer.** The placard ends in *Show in Changes* because it is a popup with
one exit. The row needs none: activating the row already fronts the worker
card and reveals its Changes shade, and an inert row has nowhere to send you.

## State

Expansion is **structure**, not appearance — an expanded row has more DOM —
so it is not a [L06] attribute toggle over always-mounted rows (the arc brief
does that inside one shade; here every arc in every project would carry a
mounted ledger it never shows). The steps mount while expanded and unmount
when folded, as the History row's detail does.

Where the bit lives is the one real design choice:

- **Per-cell `useState`** (the History row's pattern) is the smallest thing
  that works — and loses the bit when the cell scrolls out of the window and
  is recycled, or when a snapshot recompute replaces the row. On a rail card
  that re-projects on every changeset beat, that is a row folding itself shut
  while you read it.
- **Host-owned, keyed by `ownerId`** — recommended. `ArcsBody` holds
  `expanded: ReadonlySet<string>` in its own state and hands the set and a
  `toggle(ownerId)` through `CockpitRowsDataSource`, the way `tug-changes-list`
  is controlled by its host through `expandedKeys` + `onToggle`. The bit
  survives virtualization and recomputes, and it is card-local: closing the
  Arcs card folds everything, which is the right amnesia for a rail card.

Default: **every row collapsed** ([S01]).

## What a click means

- **The chevron toggles.** Nothing else does.
- **A row click stays what it is** — front the worker card on an activatable
  row, nothing on an inert one. Making inert rows toggle on click would give
  one list two click meanings distinguished only by whether a card happens to
  be open, which is the ambiguity `data-activatable` exists to remove.
- **Right-click stays the verbs menu**, expanded or not.
- **Keyboard:** the cue is a button; Space/Enter on it toggles. The list's own
  Enter-on-cell activation is untouched (the `target === currentTarget` guard
  keeps the two apart).

## Pins

- **App-test, in `at0407-arcs-card.test.ts`:** on the planned fixture arc,
  press `[data-slot="arcs-steps-fold"]`; assert `[data-slot="arcs-steps"]`
  renders one `[data-slot="arc-step"]` per ledger row with the ordinal, the
  title, and `data-status` matching the entry; assert no card was fronted
  (the focused card is unchanged); press again and assert the list is gone.
  On the brief-only fixture arc, assert no cue.
- **Unit:** none worth writing for a `Set` toggle. The lift of `ArcStepItems`
  is a move, and the placard's existing app-test (`at0473`) already reads its
  rows by `data-slot` — it is the regression pin for the lift, once the slot
  rename is applied there too.
- **Doctrine:** one design decision, recording that the Arcs row is the
  placard's reading folded, the host-owned bit, and why a row click does not
  toggle. `arc-lifecycle-block.tsx`'s docblock gains the sentence that the
  Arcs card is the first surface to fill the trailing slot.

## Decisions

Settled with the user on 2026-09-04.

**[S01] Every row starts collapsed.** The card stays a list at a glance. The
alternative — the arc bound to the followed card opening itself — was
considered and rejected: the followed card changes as you click around, and a
row that opens and shuts by itself is a row you cannot read.

**[S02] The cue is the tool-call header's cue, at the eyebrow's end.** In the
`trailing` slot `ArcLifecycleBlock` reserved for it, and it is the same
`BlockFoldCue` invocation `BlockHeader` makes — size, icons, labels, scroll
behaviour — not a variant tuned for this card. The app already has one way
to fold a block open; this is that way. A leading disclosure triangle was
rejected: it shifts every atom right by a glyph, including on rows with no
steps, and fights the eyebrow's "who" reading.

**[S03] Arc rows only.** The card's waiting plan-document rows (`PlanCell`)
carry step counts but not an arc, and their entry is a different shape. They
can follow once the arc row has settled; they are not in this arc.

## Out of scope

- The Changes shade's collapsed arc row wears the same block but has its own
  brief fold beneath it; it does not get this cue.
- Per-step actions (open the step, jump to its round). The row shows the
  ledger; it does not drive it.
