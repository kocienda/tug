<!-- tugplan-skeleton v2 -->

## Tide Session Sheet Polish + `TugListRow` Primitive {#tide-session-sheet}

**Purpose:** Fix the cluster of UI/UX glitches in the Tide card's "Choose Session" sheet, and — in the same pass — pay down the real cause behind several of them: `TugListView` has no row-chrome vocabulary, so every consumer hand-rolls its own row layout, accessory placement, and selected/hover treatment from scratch. This plan ships the three glitch fixes as small, cherry-pickable commits, then introduces `TugListRow` — a presentational row primitive modeled on UIKit's `UITableViewCell` — and migrates the session sheet's two lists onto it as the first consumer. The session sheet becomes the proving ground for the `flush` vs `pill` row treatments and the leading/trailing accessory API.

The session sheet is `TideProjectPickerForm` in `tide-card.tsx` — the sheet that drops from a Tide card's title bar to choose a project path and a session. It hosts two `TugListView` instances (Recent Project Paths, Sessions) inside `bordered` `TugBox`es. Today both lists use the iOS-`UITableView.plain`-style treatment: edge-to-edge rows, 1px hairline dividers, no rounding — all expressed as bespoke `.tide-card-picker-*` CSS. The user wants to see the alternative: discrete rounded "pill" rows in the lineage of `TugDialogButton` (the "Permission Shape" used inside `TugInlineDialog`), with the enclosing `TugBox`es dropped to the `plain` variant so the rows themselves carry the visual structure.

The work is staged smallest-blast-radius first: the three glitch fixes (Steps 1-3) each land one user-visible improvement and need no follow-on; the `TugListRow` primitive (Steps 4-5) is additive and breaks no existing `TugListView` consumer; the session-sheet migration (Steps 6-8) is the first adoption; the close-out (Step 9) confirms the rest of the consumer fleet still works untouched.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-21 |
| Roadmap anchor | [component-library-roadmap.md](./component-library-roadmap.md) |
| Predecessors | [archive/tugplan-tide-picker-redesign.md](./archive/tugplan-tide-picker-redesign.md), [archive/tugplan-tug-list-view.md](./archive/tugplan-tug-list-view.md) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

**The session sheet today.** `TideProjectPickerForm` (`tide-card.tsx`, function at ~line 1085) renders a master/detail form: a `Project path` `TugInput`, a `Recent Project Paths` list, a `Sessions` list, and the Cancel/Open actions. Both lists are `TugListView` instances wrapped in `<TugBox variant="bordered" label="…" labelPosition="legend">` (~lines 1572 and 1598). Cell renderers live in `tide-picker-cells.tsx`: `PathRecentCell` for recents; `SessionNewCell` / `SessionResumeCell` / `LoadingCell` for sessions. Each cell hand-rolls its row chrome — `.tide-card-picker-path-recent`, `.tide-card-picker-session-option` — and the picker's CSS (`tide-card.css` ~lines 393-884) re-implements row padding, hover fill, selected fill, hairline dividers, and the hover-revealed trailing trash button from primitives.

**The glitches.** Three concrete defects, reported from the running card:

1. **Mixed fonts.** The `Project path` `TugInput` renders in the sans family; the `Recent Project Paths` rows render in mono (`.tide-card-picker-path-recent` already sets `--tug-font-family-mono`). A path is a path — both surfaces should be mono so the typed path and the recent paths read as one family.
2. **Recent-path click is conditional.** The Recents list runs in `TugListView`'s `selectionRequired` mode and mirrors its owned index out through `onSelectionChange`, which is a *de-duplicated state mirror* — it fires only when the selected index *changes*. Clicking the already-selected recent does not re-fire it, so after the user edits the `Project path` input, clicking the highlighted recent does **not** restore that path. The user wants a click on any recent to set the `Project path` value **unconditionally**.
3. **Cmd-A select-all dies after a keystroke.** Select-all via Cmd-A in the `Project path` input stops working once the user has typed a character. Cmd-A is a `preventDefaultOnMatch` binding (`keybinding-map.ts:116`): the responder chain's capture-phase listener (`responder-chain-provider.tsx`, `captureListener` ~line 154) unconditionally suppresses the browser's native select-all on match, then dispatches `SELECT_ALL` to the first responder. If that dispatch does not reach the input's `handleSelectAll` (`use-text-input-responder.tsx:635`) and run its `inputRef.current.select()` continuation, the native fallback is already gone and Cmd-A is dead. The exact failure stage needs reproduction.

**The deeper cause.** Glitches 1 and 2 are symptoms of `TugListView` being a pure *windowing* primitive with no *row* vocabulary. It enumerates items, windows them, and dispatches each to a consumer-registered cell renderer; it deliberately "paints no contrast pairings of its own" (`tug-list-view.css` header). Every consumer therefore re-invents row chrome. There is no shared notion of a row variant (flush vs pill), no leading/trailing accessory API, no standard selected/hover/disabled treatment. The session sheet's trailing trash button is just a `<TugIconButton>` the cell renderer drops in as a child, with hover-reveal opacity wired by hand in `tide-card.css`.

**UITableViewCell precedent.** UIKit splits the same problem cleanly: `UITableView` owns windowing, scrolling, and selection; `UITableViewCell` owns row presentation. The cell's API is the vocabulary this plan borrows:

| `UITableViewCell` concept | What it does | `TugListRow` adoption |
|---|---|---|
| `contentView` + `textLabel` / `detailTextLabel`; `UITableViewCellStyle.subtitle` | Title over a muted subtitle in the content column | `title` + `subtitle` props; structured two-line content |
| `imageView` (leading) | Leading image/glyph column | `leading` slot (arbitrary node) |
| `accessoryView` | Arbitrary trailing control | `trailing` slot (arbitrary node) |
| `accessoryType` (`disclosureIndicator`, `checkmark`, `detailButton`, …) | *Standard* trailing affordances | Deferred — see [Q1] |
| `selectionStyle`; `isSelected` / `setSelected(_:animated:)` | Selected state + its background treatment | `selected` prop → `data-selected` attribute, CSS-driven |
| `backgroundView` / `selectedBackgroundView` | Per-state backgrounds | `data-selected` / `:hover` / `data-disabled` CSS rules |
| `separatorInset` | Inset of the hairline divider | `flush`-variant divider, token-driven inset |
| `UITableView.Style` `.plain` vs `.insetGrouped` | Edge-to-edge rows vs discrete inset cards | `flush` vs `pill` variant — see [D3] |
| `editingStyle` (`.delete` / `.insert`), `showsReorderControl`, `editingAccessoryView` | Editing-mode delete badge / reorder grip | Out of scope — see [Non-goals] |
| `reuseIdentifier` / `prepareForReuse()` | Cell reuse pool | N/A — `TugListView` reuse is item-keyed React mount/unmount ([archive/tugplan-tug-list-view.md] [D04]) |

The key structural lesson: `UITableViewCell` is **presentational** — it does not own row selection logic; the table view tells it `setSelected:`. `TugListRow` follows the same rule (see [D2]).

**`TugListView` consumer audit.** Eight files render a `TugListView`. The migration blast radius is bounded because `TugListRow` is *additive* — a cell renderer opts in by composing it, and `TugListView`'s existing cell-renderer contract is unchanged:

| Consumer | File | Row chrome today | Adopt `TugListRow`? |
|---|---|---|---|
| Picker — Recents | `tide-picker-cells.tsx` `PathRecentCell` | `.tide-card-picker-path-recent` (bespoke) | **Yes — Step 6** |
| Picker — Sessions | `tide-picker-cells.tsx` `Session*Cell` | `.tide-card-picker-session-option` (bespoke) | **Yes — Step 7** |
| Tide transcript | `tide-card-transcript.tsx` | Turn cells (`UserRowCell` / `CodeRowCell`) | No — transcript turns are not list rows; different idiom |
| Path list body kind | `body-kinds/path-list-block.tsx` `PathCell` | `.tugx-paths-row` compact `[icon] [path]` | Candidate — **defer**, confirm in Step 9 |
| Search result body kind | `body-kinds/search-result-block.tsx` | File-header + match rows (code-search idiom) | No — code-search rows are not settings-style rows |
| Gallery — list view | `cards/gallery-list-view.tsx` | Inline-styled demo cells | No — demo only |
| Gallery — headers | `cards/gallery-list-view-headers.tsx` | Inline-styled demo cells | No — demo only |
| Gallery — filter | `cards/gallery-list-view-filter.tsx` | Inline-styled demo cells | No — demo only |

Only the two picker lists migrate in this plan. The transcript, search-result, and gallery consumers are surveyed and explicitly left untouched; `path-list-block` is a candidate for a later opportunistic migration, recorded but not done here.

#### Strategy {#strategy}

- **Glitches first.** Steps 1-3 are scoped so a single commit per step is realistic: a font swap, a delegate addition, a diagnosed input-dispatch fix. Each lands a user-visible win and is cherry-pickable independent of the `TugListRow` work.
- **Diagnose before fixing.** The Cmd-A glitch (Step 3) is a *diagnose-and-fix* step. The dispatch pipeline is documented in this plan; the step reproduces the failure in the running card (HMR is always live) and fixes at the stage that actually breaks, rather than guessing.
- **Additive primitive, zero forced migrations.** `TugListRow` (Step 4) is a new tugways primitive; `TugListView`'s `rowLayout` prop (Step 5) is optional — omitting it writes no `data-row-layout` attribute and reproduces today's exact behavior. No existing consumer changes. The audit table above is the contract: only the picker migrates.
- **Design the primitive in the gallery first.** `TugListRow` ships with its own gallery card (Step 4) demonstrating both variants, accessory slots, and states *before* it is wired into the live session sheet. The visual design stays tunable in isolation.
- **One commit per step.** The build stays green at every commit: `bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` all pass. `-D warnings` enforced.
- **Tuglaws apply.** Every step touching `tide-card.tsx`, the picker cells, `tug-list-view.tsx`, or the new primitive re-checks against [tuglaws.md](../tuglaws/tuglaws.md), [component-authoring.md](../tuglaws/component-authoring.md), and [design-decisions.md](../tuglaws/design-decisions.md). Step 9 records the walkthrough. Critical: [L02] external state via `useSyncExternalStore`, [L06] appearance via CSS/DOM not React state, [L20] component-token sovereignty.
- **Pure-renderer rule preserved.** The picker's cells are pure render functions per [archive/tugplan-tide-picker-redesign.md] [D17] — no hooks. `TugListRow` is itself a pure functional component, so a cell composing it stays pure.

#### Success Criteria (Measurable) {#success-criteria}

- The `Project path` input and the `Recent Project Paths` rows render in the same monospace family. (verification: manual; `rg` for the mono token on the input's class in `tide-card.css`)
- Clicking any `Recent Project Paths` row — including the already-selected one — sets the `Project path` input to that row's path. (verification: new test against the picker form; manual)
- With the `Project path` input focused and non-empty, Cmd-A selects the full input value. (verification: manual in the running card; a lower-level test against the dispatch path if the fix admits one)
- `TugListRow` exists as a tugways primitive with a gallery card demonstrating `flush` and `pill` variants, leading/trailing accessories, and selected/disabled/hover states. (verification: gallery card renders; `bun run check` green)
- `TugListView` accepts a `rowLayout` prop; omitting it reproduces today's exact DOM and CSS for every existing consumer. (verification: existing `TugListView` tests green unmodified)
- The session sheet's Recents and Sessions lists render as `pill` rows inside `plain` `TugBox`es; the trash control and live/failed badges sit in the trailing accessory slot. (verification: manual; screenshot review with the user)
- The transcript, search-result, and gallery `TugListView` consumers are visually and behaviorally unchanged. (verification: `bun test` green; manual spot-check of the gallery list-view cards and a transcript)

#### Scope {#scope}

**In scope:**
- Mono font on the `Project path` input.
- Unconditional path-set on `Recent Project Paths` row click.
- Diagnosis and fix of the Cmd-A select-all regression in the `Project path` input.
- New `TugListRow` tugways primitive: `flush` / `pill` variants, `leading` / `trailing` accessory slots, `title` / `subtitle` structured content with a `children` escape hatch, `selected` / `disabled` state, hover-reveal trailing accessory.
- New gallery card for `TugListRow`.
- New `rowLayout` prop on `TugListView` coordinating row gap, divider strategy, and the default variant context for descendant `TugListRow`s.
- Migration of the picker's Recents and Sessions lists onto `TugListRow` with the `pill` treatment.
- Switching the Recents and Sessions enclosing `TugBox`es to the `plain` variant and the corresponding session-sheet visual polish.
- Consumer-audit confirmation: the remaining `TugListView` consumers verified unaffected.

**Out of scope (deferred):**
- Migrating `path-list-block`, `search-result-block`, the transcript, or the gallery list-view demos onto `TugListRow`. `path-list-block` is recorded as a future candidate.
- Standard `accessoryType` shorthands (disclosure chevron, checkmark, info button) — see [Q1].
- Any editing-mode model (swipe-to-delete, reorder grip, `editingStyle`) — see [Non-goals].
- Reworking `TugListView`'s `selectionRequired` / `onSelectionChange` / `delegate.onSelect` triple beyond what Step 2 needs — see [Q3].
- Section/grouping model on `TugListView` (`numberOfSections`) — still deferred per [archive/tugplan-tug-list-view.md] [D02].

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No editing mode.** UIKit's `UITableViewCell` carries an editing model — `editingStyle` (`.delete` / `.insert`), `showsReorderControl`, `editingAccessoryView`, `shouldIndentWhileEditing`. `TugListRow` deliberately ships none of it. The session sheet's per-row "forget" is a trailing accessory button, not an editing-mode delete badge. A future editing model, if ever needed, is its own plan.
- **No row-level click ownership.** `TugListRow` is presentational. It does not take an `onClick`. Activation stays with the `TugListView` cell wrapper (`.tug-list-view-cell`, which already owns `tabIndex`, click, and Space/Enter). See [D2].
- **No new section model.** This plan does not add `numberOfSections` or grouped headers to `TugListView`.

---

### Open Questions {#open-questions}

#### [Q1] Standard `accessoryType` shorthands — now or later? (RESOLVED — deferred) {#q1-accessory-types}

UIKit offers `accessoryType` (a standard disclosure chevron, checkmark, detail/info button) alongside the arbitrary `accessoryView`. Should `TugListRow` ship standard accessory *types* in v1, or only the arbitrary `leading` / `trailing` slots?

**Resolution (confirmed 2026-05-21):** defer. The session sheet needs only arbitrary slots (a `TugIconButton`, a `TugBadge`). Shipping standard types now is speculative API. Revisit when a consumer needs a disclosure chevron. Decided in [D7].

#### [Q2] Should `TugListRow` require a `TugListView` ancestor? (RESOLVED — standalone-capable) {#q2-standalone}

`TugListView`'s `rowLayout` prop ([D4]) publishes the default variant (`flush` / `pill`) to descendant rows via context, so cell renderers need not repeat `variant` per cell. Does that make `TugListRow` unusable standalone?

**Resolution (confirmed 2026-05-21):** no. `TugListRow` reads the variant from context *when present* and falls back to its own `variant` prop (default `flush`) otherwise. It is usable inside or outside a `TugListView`. Decided in [D4].

#### [Q3] Rework `TugListView`'s selection-callback triple? (RESOLVED — not in this plan) {#q3-selection-triple}

Glitch 2 exposes that `selectionRequired` + `onSelectionChange` (de-duplicated state mirror) + `delegate.onSelect` (fires on every activation) is a confusing trio — a reader reasonably expects "clicking a row" to be one callback. Should this plan reshape it?

**Resolution (confirmed 2026-05-21):** no — out of scope. Step 2 fixes the glitch correctly within the existing contract by adding a `delegate.onSelect` (every-click) alongside the existing `onSelectionChange` (mount-seed + selected visual). The triple's ergonomics are a real wart but reshaping a primitive's selection API is its own plan; this plan only records the observation.

#### [Q4] Cmd-A root cause (RESOLVED — diagnosed in Step 3) {#q4-cmd-a-cause}

The precise failure stage of the Cmd-A regression is not yet known — it requires reproduction in the running card.

**Resolution (confirmed 2026-05-21):** diagnose during implementation. Step 3 is a diagnose-and-fix step: reproduce in the running card, walk the documented dispatch pipeline, fix at the failing stage.

---

### Design Decisions {#design-decisions}

#### [D1] `TugListRow` is a new primitive, not props on `TugListView` {#d1-new-primitive}

Decided by the user during plan authoring. Row chrome lives in a dedicated `TugListRow` primitive — the `UITableView` / `UITableViewCell` split. `TugListView` stays the windowing primitive; it does not grow border-radius, accessory-layout, or content-stack props. Rationale: `TugListView`'s own design forbids it painting chrome (`tug-list-view.css` header — "the list view paints no contrast pairings of its own"); folding row presentation into it would violate that and bloat a 2200-line file. A separate primitive is also independently testable and gallery-demoable.

#### [D2] `TugListRow` is presentational — no click ownership {#d2-presentational}

`TugListRow` takes `selected` / `disabled` as inputs and reflects them to `data-` attributes for CSS; it does not own selection logic and takes no `onClick`. Activation stays with the `TugListView` cell wrapper, which already manages `tabIndex`, click, Space/Enter, and (in `selectionRequired` mode) the owned selected index. This mirrors `UITableViewCell`, which is told `setSelected:` by the table view and never decides selection itself. Consequence: a `TugListRow`'s `selected` prop is fed from the same source the cell wrapper uses (`PickerCellContext` for the sessions list; `data-selected` on the wrapper for `selectionRequired` recents).

#### [D3] Two variants: `flush` and `pill` {#d3-variants}

`TugListRow` has `variant: "flush" | "pill"`, default `flush`.

- **`flush`** — edge-to-edge row, no rounding, a 1px hairline bottom divider (token-driven inset, à la `separatorInset`), no inter-row gap. This is today's session-sheet / iOS-`UITableView.plain` look. The default, so an un-migrated mental model is preserved.
- **`pill`** — a discrete row: 1px border, `--tug-radius-md` corners, its own padding, inter-row gap, hover/selected fill. Visual lineage is `TugDialogButton` (the "Permission Shape" rendered inside `TugInlineDialog`) — the same outlined-row treatment, so the two primitives read as one family when stacked.

#### [D4] `TugListView` gains a `rowLayout` prop {#d4-row-layout}

`TugListView` gets `rowLayout?: "flush" | "pill"` — optional, no default. When set it does three coordinated things so a consumer picks the row treatment in *one* place:

1. Sets `--tugx-list-view-row-gap` (0 for `flush`, a small gap for `pill`).
2. Writes `data-row-layout` on the scroll container so the `flush` hairline-divider rule (a `.tug-list-view-cell:not(:last-child)` border) is scoped to flush lists only.
3. Publishes the layout to descendant `TugListRow`s through a React context, so cell renderers compose `<TugListRow leading=… trailing=…>` without repeating `variant` on every cell.

**Amendment (2026-05-21, from Step 5 implementation):** the prop has *no* default. Omitting it writes no `data-row-layout` attribute at all, so none of the layout CSS applies and the list keeps today's default comfortable row gap with no dividers — byte-identical to the pre-`rowLayout` behavior. The earlier "default `flush`" framing was an error: `flush` means 0-gap + dividers, which is *not* today's default (a comfortable `--tug-space-sm` gap, no dividers). `flush` and `pill` are both explicit opt-ins; the absent state is the third, unchanged behavior. `TugListRow`'s own `variant` prop still overrides the context when a consumer needs a one-off (see [Q2]).

#### [D5] Non-breaking — only the picker migrates {#d5-non-breaking}

Per the consumer audit, `TugListView`'s cell-renderer contract is unchanged and `rowLayout` defaults to today's behavior, so the transcript, search-result, path-list, and gallery consumers compile and render byte-identically with no edits. Only `tide-picker-cells.tsx` changes. The user's concern — "a number of `TugListView` usages we'll need to update" — is answered by additivity: there is nothing to update except the one surface being redesigned.

#### [D6] Structured `title` / `subtitle` content, with a `children` escape hatch {#d6-content}

`TugListRow` offers `title` (string) and optional `subtitle` (ReactNode) for the common two-line content column — the `UITableViewCellStyle.subtitle` shape — and the picker's session rows use it. For non-standard content (the recents row is a single RTL middle-ellipsis path with `<mark>` highlight ranges), `children` is the escape hatch: when `children` is provided it owns the content column and `title` / `subtitle` are ignored. This standardizes the common case without forcing every consumer through it.

#### [D7] Accessory model: arbitrary `leading` / `trailing` slots only in v1 {#d7-accessories}

`leading` and `trailing` are arbitrary ReactNode slots — UIKit's `accessoryView` / leading `imageView`, generalized. No standard `accessoryType` shorthands in v1 ([Q1]). The session sheet's trailing trash `TugIconButton` and live/failed `TugBadge` go in `trailing`; both stay `TugIconButton` / `TugBadge` per [archive/tugplan-tide-picker-redesign.md] [D16]. A `trailingReveal?: "always" | "hover"` prop (default `always`) moves the picker's hand-rolled hover-reveal opacity into the primitive.

---

### Specification {#specification}

#### `TugListRow` public API {#spec-tug-list-row}

New file pair: `tugdeck/src/components/tugways/tug-list-row.tsx` + `tug-list-row.css`.

```ts
export type TugListRowVariant = "flush" | "pill";

export interface TugListRowProps {
  /** Row presentation. Defaults to the enclosing TugListView's
   *  `rowLayout` (via context), then to "flush". [D3] [D4] */
  variant?: TugListRowVariant;

  /** Leading accessory — icon, status glyph, image. UIKit `imageView`. */
  leading?: React.ReactNode;

  /** Trailing accessory — control or badge. UIKit `accessoryView`. */
  trailing?: React.ReactNode;

  /** Reveal policy for `trailing`. "hover" hides it until row
   *  hover / focus-within. Default "always". [D7] */
  trailingReveal?: "always" | "hover";

  /** Structured content — title over an optional muted subtitle.
   *  Ignored when `children` is provided. [D6] */
  title?: string;
  subtitle?: React.ReactNode;

  /** Free-form content column. Overrides `title` / `subtitle`. [D6] */
  children?: React.ReactNode;

  /** Selected state → `data-selected`. Fed by the consumer; the row
   *  does not own selection. [D2] */
  selected?: boolean;

  /** Disabled state → `data-disabled` (dimmed, not-allowed). [D2] */
  disabled?: boolean;

  /** Cascade-scoped customization hook ([L20]). */
  className?: string;
}
```

- Root element: a `<div data-slot="tug-list-row">` carrying `data-variant`, `data-selected`, `data-disabled` per [L06]. Not a `<button>` — activation is the cell wrapper's job ([D2]).
- Layout: `[leading?] [content (flex)] [trailing?]`, leading and trailing `flex: 0 0 auto`, content `flex: 1; min-width: 0` so titles truncate.
- Tokens: owns the `--tugx-list-row-*` family ([L20]); each slot resolves to a `--tug7-*` / `--tug-*` base token in one hop ([L17]). Pairings declared in the CSS header ([L16]).
- `flush`: bottom hairline via `--tugx-list-row-divider-*`, inset by `--tugx-list-row-divider-inset`. `pill`: `--tug-radius-md` border + per-state fills modeled on `TugDialogButton`'s outlined-action cascade.

#### `TugListView` `rowLayout` addition {#spec-row-layout}

```ts
// added to TugListViewProps:
/** Row presentation for descendant TugListRows. When set, scopes the
 *  row gap and the flush divider rule (via `data-row-layout`) and
 *  publishes the variant via context. Omitted ⇒ no attribute, no
 *  context — today's exact behavior. */
rowLayout?: TugListRowVariant;
```

- The scroll container gains `data-row-layout={rowLayout}` — React omits the attribute entirely when `rowLayout` is `undefined`, so an un-opted-in list is byte-identical to before.
- `tug-list-view.css` sets `--tugx-list-view-row-gap` per `data-row-layout` and scopes the `flush`-only hairline rule. With no `data-row-layout`, none of the row-layout rules match and the `body{}` default gap stands.
- `TugListView` wraps its rendered window with `TugListRowLayoutProvider` (value `rowLayout ?? null`) — the context + provider were defined in `tug-list-row.tsx` in Step 4; `TugListRow` consumes the context as its `variant` default.

#### New / modified files {#spec-files}

**New:**
- `tugdeck/src/components/tugways/tug-list-row.tsx`
- `tugdeck/src/components/tugways/tug-list-row.css`
- `tugdeck/src/components/tugways/cards/gallery-tug-list-row.tsx`
- `tugdeck/src/components/tugways/__tests__/tug-list-row.test.ts` (pure-logic only — variant/context resolution; no DOM-render test, per the no-fake-DOM rule)

**Modified:**
- `tugdeck/src/components/tugways/tug-list-view.tsx` (+ `tug-list-view.css`) — `rowLayout` prop, `data-row-layout`, context provider.
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — Recents/Sessions `TugListView` props; `TugBox` variant; `TugInput` class.
- `tugdeck/src/components/tugways/cards/tide-picker-cells.tsx` — cells compose `TugListRow`.
- `tugdeck/src/components/tugways/cards/tide-card.css` — picker CSS reduced to what `TugListRow` does not own.
- `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` — register the new gallery card.
- `tugdeck/src/components/tugways/use-text-input-responder.tsx` *or* the picker form — whichever Step 3's diagnosis points at.
- `dash/component-library-roadmap.md` — add `tug-list-row` to the component inventory.

---

### Steps {#steps}

Each step is its own commit. `bun run check`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at the end of every step. HMR is live throughout — no manual builds for tugdeck.

#### Step 1 — `Project path` input renders in the monospace family {#step-1}

**Status:** ✅ Complete — 2026-05-21. The `tide-card-picker-path-input` rule is scoped under `.tide-card-picker-field` (specificity 0,2,0) so it wins over `.tug-input`'s `font-family: inherit` regardless of stylesheet load order — a deliberate robustness choice over a bare single-class selector that would tie on specificity.

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (the `Project path` `TugInput`, ~line 1556).
- `tugdeck/src/components/tugways/cards/tide-card.css` (`.tide-card-picker-field` / a new input class).

**Work:**
- [x] Give the `Project path` `TugInput` a picker-scoped class (`tide-card-picker-path-input`) and a CSS rule setting `font-family: var(--tug-font-family-mono)`, so the typed path and the recent paths below it share one family.
- [x] Match the existing recents treatment: `.tide-card-picker-path-recent` also pins `-webkit-font-smoothing: antialiased` / `-moz-osx-font-smoothing: grayscale`; apply the same to the input so the two never disagree on text rendering.
- [x] Do not touch `TugInput` itself — this is a cascade-scoped override on one instance ([L20]).

**Verification:**
- [x] `bun run check` + `bun test` green (2350 pass / 0 fail); `bun run audit:tokens lint` zero violations.
- [ ] Manual: open the session sheet — the `Project path` value and the `Recent Project Paths` rows render in the same mono face.

#### Step 2 — Recent-path click sets `Project path` unconditionally {#step-2}

**Status:** ✅ Complete — 2026-05-21. The shared helper `handleRecentSelectionChange` was renamed `applyRecentPath` to read neutrally now that it serves both surfaces. **Plan amendment:** the dedicated "new test" is relocated — see Verification.

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (`TideProjectPickerForm` — the Recents `TugListView`; `applyRecentPath` + `recentsDelegate`).

**Work:**
- [x] Add a `delegate` to the Recents `TugListView` whose `onSelect(index)` reads `recentsDataSource.rowAt(index)` and, for a `path-recent` row, calls `setPath(row.path)` unconditionally. `delegate.onSelect` fires on **every** activation (click / Space / Enter), including a re-click of the already-selected row.
- [x] Keep `selectionRequired` + `onSelectionChange` — they still own the selected-row highlight and the mount-time seed that fills the input from the first recent before any click. `onSelectionChange` is the de-duplicated state mirror (mount seed); `delegate.onSelect` is the every-click handler. Both route into the same `setPath`.
- [x] Factor the shared body into one helper (`applyRecentPath`) so seed and click cannot drift.

**Verification:**
- [x] `bun run check` + `bun test` green (2350 pass / 0 fail).
- [x] Correct-by-construction: `TugListView`'s cell click handler (`tug-list-view.tsx` `clickCb`) fires `delegate.onSelect(index)` on every activation of a `cell`-role row — the already-selected row included — and `keyDownCb` does the same for Space/Enter with `stopPropagation()` so the form's `onKeyDown` does not double-handle. Verified in source.
- [x] **Plan amendment — automated coverage relocated.** With no fake-DOM render harness (happy-dom removed 2026-05-13), a `bun:test` render test of `TideProjectPickerForm` is not possible — the original "new test against `TideProjectPickerForm`" item cannot run under `bun test`. Rather than a standalone picker app-test that duplicates the picker-sheet setup, the recents-re-click assertion is folded into [Step 3](#step-3)'s app-test, which already drives the real session sheet in a running app for the Cmd-A reproduction. One picker app-test, shared setup, both picker-input glitches covered. **Note:** Step 3 is now deferred — this app-test lands with it. The fix itself remains correct-by-construction (verified above); only the regression test waits.
- [ ] Manual: edit the `Project path`, click the highlighted recent — the input snaps back to that path.

#### Step 3 — Diagnose and fix Cmd-A select-all in `Project path` {#step-3}

**Status:** ⏸️ Deferred — 2026-05-21. Deferred at the user's direction. The Cmd-A failure is judged a symptom of broader focus / keyboard / first-responder / tab-order issues that warrant one comprehensive treatment rather than a point fix; the user is gathering notes for that work. This step — and the picker app-test it carries (which also covers Step 2's recents-re-click assertion) — resumes once that work lands.

**Files:**
- To be determined by diagnosis. Candidates: `tugdeck/src/components/tugways/use-text-input-responder.tsx` (`handleSelectAll`, line 635), `tugdeck/src/components/tugways/cards/tide-card.tsx` (`TideProjectPickerForm` — `handleFormKeyDown`, the recents-seed `setPath` re-render), `tugdeck/src/components/tugways/responder-chain-provider.tsx` (`captureListener`).

**Work:**
- Reproduce in the running card: open the session sheet, type a character into `Project path`, press Cmd-A.
- Walk the documented dispatch pipeline and find the stage that breaks:
  1. **Keybinding match** — `keybinding-map.ts:116` matches Cmd-A → `SELECT_ALL`, `preventDefaultOnMatch: true`. The capture-phase `captureListener` (`responder-chain-provider.tsx` ~line 154) `preventDefault()`s the native select-all.
  2. **First-responder dispatch** — `manager.sendToFirstResponderForContinuation({ action: SELECT_ALL })`. Confirm the focused `TugInput` is the resolved first responder *after* the recents-seed re-render (the seed fires `onSelectionChange` → `setPath` → a re-render right after the input is autofocused) and that it still carries `data-responder-id`.
  3. **Handler + continuation** — the input's `handleSelectAll` returns a continuation `() => inputRef.current?.select()`; confirm it runs and that `document.activeElement` is the input at run time.
  4. **Selection persistence** — confirm no re-render immediately re-assigns `input.value` and collapses the just-made selection.
- Fix at the failing stage. Because the native select-all is unconditionally suppressed on match, *any* break above leaves Cmd-A dead — the fix must restore a working `select()`, not merely re-enable the native path.
- Add a pure-logic or dispatch-path `bun:test` guard if the fix admits one (e.g. the failing stage turns out to be a pure function).
- **Picker app-test (covers Steps 2 and 3).** Author a new app-test (`tests/app-test/atNNNN-tide-picker-input-behaviors.test.ts`) that drives the real session sheet in a running Tug.app — modeled on `at0045-tug-text-editor-cmd-a-after-typing`. It seeds recents into tugbank, opens a Tide card so the picker sheet drops, and asserts both picker-input glitches in one setup:
  1. **Step 2 — recents re-click.** Edit the `Project path` input, then re-click the already-selected `Recent Project Paths` row; assert the input value is restored to that row's path.
  2. **Step 3 — Cmd-A after typing.** Type into `Project path`, press Cmd-A, assert the full value is selected.

**Verification:**
- `bun run check` + `bun test` green.
- `just app-test atNNNN-tide-picker-input-behaviors.test.ts` green (requires `just build-app` first so the bundled dist carries Steps 1-3).
- Manual: type into `Project path`, press Cmd-A — the whole value is selected; typing replaces it. Repeat after editing mid-string.

#### Step 4 — `TugListRow` primitive + gallery card {#step-4}

**Status:** ✅ Complete — 2026-05-21. Three notes for Step 5: (1) `TugListRowLayoutContext` and the exported `TugListRowLayoutProvider` were created in `tug-list-row.tsx` — the row primitive owns the context that configures it — so Step 5's `TugListView` only imports and wraps with the provider. (2) The `flush` variant is transparent and inherits its text color from the host surface; only `pill` paints its own foreground, which keeps the `@tug-pairings` block honest (a `flush` row genuinely renders on the container's surface). (3) `tug-list-row.css` is not in the audit tool's hand-curated `COMPONENT_CSS_FILES` list (which omits most post-legacy components), so `audit:tokens lint` does not scan it — but the file follows the component-authoring conventions in full anyway: `@tug-pairings` compact + expanded blocks, `@tug-renders-on` on the one color-without-background rule, one-hop `--tugx-list-row-*` aliases.

**Files:**
- New: `tugdeck/src/components/tugways/tug-list-row.tsx`, `tug-list-row.css`, `cards/gallery-tug-list-row.tsx`, `__tests__/tug-list-row.test.ts`.
- `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` (register the card).

**Work:**
- [x] Build `TugListRow` per the [Specification](#spec-tug-list-row): `flush` / `pill` variants, `leading` / `trailing` slots, `trailingReveal`, `title` / `subtitle` / `children`, `selected` / `disabled`. Presentational only — no `onClick`.
- [x] CSS: own the `--tugx-list-row-*` token family ([L20]); one-hop resolution to base tokens ([L17]); declare pairings in the header ([L16]); state via `data-` attributes + CSS ([L06]). The `pill` cascade borrows `TugDialogButton`'s outlined-action rest/hover/selected treatment so the two primitives read as a family.
- [x] Add `data-slot="tug-list-row"` and the exported props interface per [component-authoring.md] / [L19].
- [x] Gallery card: demo both variants, leading/trailing accessories, `trailingReveal: "hover"`, selected/disabled/hover states, consumer-owned selection, and the `children` escape hatch.
- [x] Test: pure-logic only — variant resolution (prop vs context vs default), `children`-overrides-`title` precedence. No DOM-render test.

**Verification:**
- [x] `bun run check` + `bun test` (2358 pass / 0 fail, 8 new) + `bun run audit:tokens lint` (zero violations) green.
- [ ] Manual: the `TugListRow` gallery card renders both variants and all states correctly.

#### Step 5 — `TugListView` `rowLayout` prop {#step-5}

**Status:** ✅ Complete — 2026-05-21. **Plan amendment:** [D4] and the [Specification](#spec-row-layout) said the prop "defaults to `flush`". Implementation showed that was an error — `flush` is 0-gap + dividers, which is *not* today's default (a comfortable `--tug-space-sm` gap, no dividers). The prop has no default: omitting it writes no `data-row-layout` attribute, so an un-opted-in list is byte-identical to before. [D4] and the Spec are corrected accordingly.

**Files:**
- `tugdeck/src/components/tugways/tug-list-view.tsx` + `tug-list-view.css`.

**Work:**
- [x] Add `rowLayout?: TugListRowVariant` to `TugListViewProps`. `data-row-layout={rowLayout}` on the scroll container — React omits the attribute when the prop is `undefined`, so an un-opted-in list is byte-identical.
- [x] In `tug-list-view.css`, drive `--tugx-list-view-row-gap` off `data-row-layout` (`0` for `flush`, `--tugx-list-view-pill-row-gap` for `pill`) and scope the `:not(:last-child)` hairline divider to `[data-row-layout="flush"]` only. With no attribute, none of the row-layout rules match and the `body{}` default gap stands.
- [x] Import `TugListRowLayoutProvider` (defined in `tug-list-row.tsx` in Step 4) and wrap the rendered window with it (`value={rowLayout ?? null}`); `TugListRow` consumes the context as its `variant` default.
- [x] tuglaw cross-check: [L02] `rowLayout` is a prop, not subscribed state; [L06] presentation via the `data-row-layout` attribute + CSS; [L17] new `--tugx-list-view-*` aliases resolve to base in one hop; [L20] tug-list-view.css's `@tug-pairings` updated from `none` to declare the one divider pairing it now paints.

**Verification:**
- [x] `bun run check` + `bun test` green — **2358 pass / 0 fail, identical to Step 4**: every existing `TugListView` test passes **unmodified** (proof of non-breaking). `bun run audit:tokens lint` zero violations.
- [ ] Manual: a `TugListView` with no `rowLayout` (transcript, gallery) is byte-identical; a `TugListRow` with no `variant`, inside a `rowLayout="pill"` list, picks up `pill` from context (exercised for real by the picker migration in Step 6).

#### Step 6 — Migrate the Recents list to `TugListRow` (`flush`) {#step-6}

**Status:** ✅ Complete — 2026-05-21. First built with `rowLayout="pill"`; on visual review the user chose **`flush`** — edge-to-edge rows read better for single-line path content than discrete bordered pills. Revised to `flush` (the row separators come for free from Step 5's `rowLayout="flush"` CSS — a hairline below every cell but the last). The two structural amendments below are variant-agnostic and stand unchanged.

Two amendments. (1) **Files** also includes `tug-list-view.tsx`: the plan said "`selected` is fed from the cell wrapper's `data-selected` source," but feeding selection that way would force the picker CSS to either reach into `TugListRow`'s `--tugx-list-row-*` tokens or duplicate their base-token values (drift risk — not test-of-time). The clean design is a small additive `selected: boolean` field on `TugListViewCellProps`: `selectionRequired` mode already computes the owned selected index, so the list view surfaces it *two ways from one source* — `data-selected` on the wrapper (the CSS-cascade hook, kept) and the `selected` cell prop (the render-logic hook). `PathRecentCell` forwards the prop straight into `TugListRow`'s own `selected` mechanism — no token reach-in, no duplication, selection still owned solely by the list view. (2) `PathRecentCell` composes `<TugListRow>` with **no** `variant` prop — it inherits the variant from the Recents list's `rowLayout` through `TugListRowLayoutContext`, the DRY path [Q2]/[D4] designed.

**Forward note for [Step 8](#step-8):** the plan's premise there — "with pill rows carrying their own borders, the box border is redundant → switch to `plain`" — does **not** hold for the Recents box now: `flush` rows have no border of their own and need an enclosing frame, so the Recents `TugBox` likely stays `bordered`. Re-evaluate at Step 8 per list.

**Files:**
- `tugdeck/src/components/tugways/tug-list-view.tsx` (additive `TugListViewCellProps.selected` — see Status).
- `tugdeck/src/components/tugways/cards/tide-picker-cells.tsx` (`PathRecentCell`).
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (Recents `TugListView` — `rowLayout="flush"`, className drops the shared `tide-card-picker-list-view`).
- `tugdeck/src/components/tugways/cards/tide-card.css` (retire the bespoke `.tide-card-picker-path-recent` row chrome that `TugListRow` now owns).

**Work:**
- [x] `PathRecentCell` composes `TugListRow` with the RTL middle-ellipsis path + `<mark>` highlights as `children` (the escape hatch). `selected` is forwarded from the new `TugListViewCellProps.selected` so the `selectionRequired` highlight is painted by `TugListRow`'s `[data-selected]` treatment.
- [x] Set `rowLayout="flush"` on the Recents `TugListView`; drop `tide-card-picker-list-view` from its className so the shared bespoke iOS-table rules no longer apply — `rowLayout="flush"` now drives the zero gap and the `:not(:last-child)` hairline dividers from `tug-list-view.css`.
- [x] Trim `tide-card.css`: `.tide-card-picker-path-recent` keeps only content-level treatment (mono family, RTL/ellipsis, font-smoothing pin); row padding / hover / selected rules are deleted — `TugListRow` owns them. `cursor: pointer` moves to the cell wrapper. `.tide-card-picker-match` `<mark>` styling is untouched.

**Verification:**
- [x] `bun run check` + `bun test` green — **2358 pass / 0 fail, identical to Step 5**: the additive required `selected` field broke no cell renderer and no test. `bun run audit:tokens lint` zero violations. (No `bun:test` "Step 2 test" exists — that coverage was relocated to the deferred Step 3 app-test.)
- [ ] Manual: the Recents list shows edge-to-edge `flush` rows with hairline separators between them; selection highlight, hover, and click-to-fill all still work.

#### Step 7 — Migrate the Sessions list to `TugListRow` (`pill`) {#step-7}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-picker-cells.tsx` (`SessionNewCell`, `SessionResumeCell`, `LoadingCell`).
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (Sessions `TugListView` — add `rowLayout="pill"`).
- `tugdeck/src/components/tugways/cards/tide-card.css` (retire `.tide-card-picker-session-option` row chrome).

**Work:**
- `SessionResumeCell` composes `<TugListRow variant="pill" title={snippet} subtitle={subtitleText} trailing={…} trailingReveal="hover">`. The trailing slot holds the trash `TugIconButton` for non-live rows and the `live` / `failed` `TugBadge` otherwise — preserving [archive/tugplan-tide-picker-redesign.md] [D16] (trailing in-list actions are `TugIconButton`s) and [D14] (no per-cell floating surfaces — the forget-confirmation popover stays form-owned).
- `SessionNewCell` composes `<TugListRow variant="pill" title="New session">`. `LoadingCell` keeps its inert placeholder.
- `selected` / `disabled` (live rows) feed from `PickerCellContext` as today.
- Preserve the `data-session-id` / `data-pending-forget` markers the form's anchor-resolution layout effect depends on (`tide-card.tsx` ~line 1195) — they must remain reachable on the row element.
- Trim `tide-card.css` for the sessions list as in Step 6.

**Verification:**
- `bun run check` + `bun test` green.
- Manual: New-session, resume rows, the hover-revealed trash button, the forget-confirmation popover anchoring, and live/failed badges all work; selecting and Open still resolve correctly.

#### Step 8 — `plain` `TugBox`es + session-sheet visual polish {#step-8}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (the two `TugBox`es, ~lines 1572 and 1598).
- `tugdeck/src/components/tugways/cards/tide-card.css` (`.tide-card-picker-box` and friends).

**Work:**
- Switch the `Recent Project Paths` and `Sessions` `TugBox`es from `variant="bordered"` to `variant="plain"` — with `pill` rows carrying their own borders, the box border is now a redundant nested frame. Keep the `labelPosition="legend"` section headers.
- Adjust the picker layout CSS: with `plain` boxes, revisit the host heights, the box padding (`--tugx-box-padding`), and the spacing between the legend and the first pill so the sheet reads as clean vertical rhythm rather than boxes-within-boxes.
- This is the visual review checkpoint — present a screenshot to the user and tune.

**Verification:**
- `bun run check` + `bun test` green.
- Manual / screenshot review with the user: the session sheet reads as pill rows under plain section headings; spacing is balanced; no double-frame.

#### Step 9 — Consumer-audit confirmation + tuglaws walkthrough {#step-9}

**Files:**
- `dash/component-library-roadmap.md` (add `tug-list-row`).
- This plan (record the walkthrough).

**Work:**
- Confirm the [consumer audit](#context): the transcript, search-result, path-list, and gallery `TugListView` consumers compile and render unchanged — `rg` for `rowLayout` to confirm only the picker passes it; spot-check a transcript and the three gallery list-view cards in the running app.
- Re-confirm `path-list-block` as a deferred candidate; leave a one-line note in this plan if it should become its own follow-up.
- Add `tug-list-row` to the component-library-roadmap inventory table.
- Walk `TugListRow`, the `TugListView` change, and the migrated cells against [tuglaws.md], [component-authoring.md], and [design-decisions.md]. Record the laws touched ([L02], [L06], [L17], [L19], [L20]) and confirm no violation.

**Verification:**
- `bun run check` + `bun test` + `bun run audit:tokens lint` + `cargo nextest run` green.
- Manual: full session-sheet pass plus a transcript and gallery spot-check.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

Per the standing practice, every step touching tugways primitives re-reads the laws before implementation; the commit message names the laws touched. The load-bearing ones for this plan:

- **[L02]** External state via `useSyncExternalStore`. `TugListRow` is presentational and holds no external state; `TugListView`'s `rowLayout` is a prop, not subscribed state. No new `useState` mirrors of external state.
- **[L06]** Appearance via CSS / DOM attributes, never React state. `TugListRow`'s `variant` / `selected` / `disabled` and `TugListView`'s `data-row-layout` are `data-` attributes; all state visuals are CSS.
- **[L17]** Component tokens resolve to base tokens in one hop. Every `--tugx-list-row-*` slot → a `--tug7-*` / `--tug-*` token directly.
- **[L19]** Component-authoring guide — file pair, module docstring, exported props interface, `data-slot` on the root, gallery card.
- **[L20]** Component-token sovereignty — `TugListRow` owns `--tugx-list-row-*` and composes no other component's tokens; the picker customizes via cascade-scoped overrides.
- **[archive/tugplan-tide-picker-redesign.md] [D14] / [D16] / [D17]** preserved — no per-cell floating surfaces, trailing actions stay `TugIconButton`s, cells stay pure render functions.

Step 9 records the completed walkthrough.
