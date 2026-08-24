<!-- devise-skeleton v4 -->

## List Filtering — TugFilterField + fuzzy narrowing for long lists {#phase-slug}

**Purpose:** Ship a proper filter affordance — a `TugFilterField` component with a `TugFilterFieldDelegate` protocol — and adopt it across the five long lists: the Choose Session picker, the `/resume` overlay, and the Lens's Sessions / Snippets / Text Files sections. Filtering is fuzzy (subsequence-tolerant), live per keystroke, and trims the list to what the user is *not* excluding; matched title spans are highlighted.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-24 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Session picker for a busy project path lists hundreds of sessions (the tugtool path currently lists ~896), and the Lens's three lists (Sessions, Snippets, Text Files) grow without bound. Long lists are cumbersome: the user usually knows a fragment — a tag word, a snippet incipit, a filename — and wants everything else out of the way. The goal is a *trimming* filter, not a pinpoint search: fuzzy matching keeps rows the fragment plausibly names and drops the rest.

The codebase already contains three partial implementations of this idea, none of them a component: the `/resume` overlay hand-wires a `TugInput` into `SessionsDataSource`'s `tagFilter` input using the substring-only `matchesTagQuery` (`tugdeck/src/lib/session-tag.ts`), the picker's path combo-box filters recents with `caseInsensitiveSubstring`, and the gallery card `gallery-list-view-filter.tsx` demos the `useFilteredDataSource` wrapper with its own inline input and a private `renderHighlighted`. This plan unifies them behind one component, one delegate protocol, and one shared matcher.

#### Strategy {#strategy}

- Build the pure matching layer first (`text-match.ts` extensions), then the component (`TugFilterField` + delegate), then adopt surface by surface: gallery → sessions data source (`/resume`) → picker → Lens.
- Filtering is a **data-source input**, applied inside each data source's `recompute()` — the same shape as today's `tagFilter` — not a wrapper layered on top ([P02]). Cell renderers, `rowAt`, `indexForId`, selection, and cursor code all keep working in one (filtered) coordinate space.
- Matching is fuzzy and **ranked**: `scoreMatch`'s score decides in/out AND the order while a query is active; native order returns when it clears ([P03], revised after the first build — see [P13]).
- Highlights ride the row **title** through a widened `TugListRow.title` prop and a shared highlight helper, reusing the one find-paint token family ([P04]).
- The two known risks — selection behavior when the selected row is filtered away, and a Lens section filtered to zero rows becoming keyboard-unreachable — are settled by inspection in [Deep Dives](#deep-dives) and closed by specific tasks ([R01], [R02]).
- Query state is transient everywhere: React state in the picker and `/resume`, a module store for the Lens (band and body are sibling components). Never persisted to tugbank.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `scarp` into the picker's filter narrows the SESSIONS list to rows whose title/tag/prompt/id fuzzily match; Backspace widens; ✕ clears to the full list. (app-test)
- The filter is fuzzy: `sesldg` matches a row titled `session-ledger-store` (subsequence tier); `tug ledger` (two terms) matches a row containing both terms across its fields (AND semantics). (unit tests on `filterQueryMatch`)
- Matched spans in row **titles and subtitles** render highlighted `<mark>` segments, computed against the exact rendered string; clearing the query renders plain strings identical to today's output. (unit test on the highlight helper + visual check)
- `TugListRow` renders string and node subtitles through one `TugLabel` path: `subtitleMaxLines` is honored for both, and a selected row recolors its subtitle identically for both. (unit + visual check; today the node branch ignores `subtitleMaxLines` and only it matches the selected-state rule)
- With a filter active in the picker, selecting a row and pressing Open resumes exactly that row's session (no positional drift), and ArrowDown out of the filter field lands on the first matching session rather than "New session". (app-test AT0265)
- Escape in a non-empty filter field clears the field and does not dismiss the enclosing sheet or section; Escape in an empty field falls through to the surface's normal ladder. (app-tests AT0265 / AT0266)
- A Lens section filtered to zero rows shows a "No matches" body, keeps its filter field clickable and clearable, and drops out of the ⌘L seed; clearing restores the rows. (app-test + unit)
- Snippet editing and row deletion behave correctly while a filter is active; grip reorder is unavailable while filtered. (unit tests on the data source + manual)
- `/resume` overlay behavior is preserved (non-matching query → empty list, no spawn) but with fuzzy matching and the shared component; `matchesTagQuery` is deleted.
- `bunx tsc --noEmit`, `bun test`, `bunx vite build`, and `just app-test` are all green at the end.

#### Scope {#scope}

1. `TugFilterField` component + `TugFilterFieldDelegate` protocol (tugways).
2. Shared fuzzy matcher + highlight-range helpers in `src/lib/text-match.ts`; shared `<mark>` renderer.
3. `TugListRow` text-line repairs: `title` widened to a React node, and the split string-vs-node `subtitle` rendering unified onto one `TugLabel` path ([P11]) — both still through `TugLabel`.
4. Adoption: gallery filter card, `SessionsDataSource` (`/resume` + picker), Lens Sessions / Snippets / Text Files.
5. Lens plumbing: `filterable` on `LensSectionDefinition`, band-mounted field, transient per-section query store.
6. Tests: unit (matchers, data sources), app-tests (picker filter flow, lens filter flow).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Ranking/re-ordering rows by match score (native order always; a per-list opt-in rank flag is a follow-on).
- Filtering the transcript, the path combo-box recents (already has its own matcher), or any sheet list (help/skills/agents) — those can adopt later.
- Persisting filter queries across sessions or reloads.
- Server-side filtering; all five lists are client-resident.
- Changing the "X of Y" collapsed summaries in the Lens to reflect the filter ([Q02] — deferred).

#### Dependencies / Prerequisites {#dependencies}

- `useFilteredDataSource` stays as-is (generic composition path; the gallery continues to demo it).
- `scoreMatch` in `src/lib/text-match.ts` (exists; subsequence-capable, returns highlight ranges).
- `TugInput`, `TugIconButton`, `useFocusable`, `FocusManager.place` (all exist).
- No Rust/tugcast changes; this is a tugdeck-only phase.

#### Constraints {#constraints}

- Tuglaws: [L02] external state via `useSyncExternalStore`; [L03] registrations in `useLayoutEffect`; [L06] appearance via CSS/DOM; [L11] controls emit actions; [L17]/[L20] token sovereignty; [L19] component authoring; [L22] focus via FocusManager; [L24] local UI state. Cross-check `tuglaws/tuglaws.md`, `tuglaws/list-view-usage.md`, `tuglaws/component-authoring.md`, `tuglaws/focus-language.md` before each tugways step.
- No `localStorage`/IndexedDB; transient state only (no tugbank either — deliberately not persisted).
- `bunx vite build` must pass before any step is declared done (production rollup differs from dev esbuild).
- Never hand-roll UI that exists as a Tug\* component; `TugFilterField` composes `TugInput` + `TugIconButton`.

#### Assumptions {#assumptions}

- Filter queries are short (a word or two); per-keystroke recompute over ≤ ~1000 rows of small strings is well under a frame. No debounce needed.
- The lens sections' row counts are small (tens); the picker is the largest consumer (~900 rows) and its recompute already runs per ledger tick today.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]`/`[Q##]`/`R##`/`S##` stable labels (two digits, never reused), `**Depends on:**` lines with `#step-N` anchors, and rich `**References:**` lines on every step. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Subtitle highlighting (DECIDED — ships in v1, see [P11]) {#q01-subtitle-highlight}

**Question:** Should matched spans in row *subtitles* (e.g. the picker's `tame-scarp · 22h ago · …` metadata line) also be highlighted?

**Why it matters:** When the match is only in the tag or prompt and the title shows something else, the row survives with no visible highlight, which reads as a false positive.

**Resolution:** DECIDED — yes, in v1, gated on first repairing `TugListRow`'s split subtitle rendering ([P11]). The original instinct was to defer because a *node* subtitle bypasses `TugLabel`; inspection showed that bypass is not a constraint to route around but a defect to fix — see [P11] for the evidence and the (small) audit surface.

#### [Q02] Filter-aware collapsed summaries (DEFERRED) {#q02-collapsed-summary}

**Question:** Should a collapsed Lens section's summary show "3 of 12" while its (hidden) filter is active?

**Resolution:** DEFERRED. The query survives collapse (module store, [P06]) so this is purely additive later; keeping summaries untouched avoids churn in three `collapsedSummary` factories now.

#### [Q03] ArrowDown key-forwarding vs. focus hand-off (DECIDED — hand-off) {#q03-arrow-handoff}

**Question:** Should ArrowDown in the field *forward* key events into the list (the `keyboardSubordinate` shape) or *move the key view* onto the list?

**Resolution:** DECIDED, see [P10]. Hand-off via `FocusManager.place` matches the picker's existing keyboard model (the sessions list is its own `singleSelect` stop in `PICKER_CYCLE_GROUP`) and the Lens's band-click model. `keyboardSubordinate` (list contributes zero Tab stops, input owns the ring) remains available for future popup-style consumers but is not used here.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Selection drifts to a wrong row when filtering (R01) | high (wrong session resumed) | med | id-based snap-back reads the filtered projection; `session-new` always present in picker | any app-test failure on open-after-filter |
| Lens section filtered to zero becomes keyboard-dead (R02) | med | med | field registers independently of `hasContent`; "No matches" state | field unreachable in manual/AT run |
| Snippets index-mixing under filter (R03) | med (wrong snippet deleted/edited) | high without fixes | route every index through the data source; disable grip reorder while filtered | unit tests on filtered DS |
| Per-keystroke recompute jank on ~900 rows | low | low | membership-only match, no sort, windowed rendering | profile if typing feels sluggish |
| `TugListRow.title` widening regresses a consumer | low | low | type-level change only; all existing callers pass strings | tsc + visual pass |

**Risk R01: Selection identity under an active filter** {#r01-selection-under-filter}

- **Risk:** `TugListView` selection is positional. `resolveSelectionIndex` (in `tugdeck/src/components/tugways/tug-list-view.tsx`) keeps the *current index* when it still points at a selectable row — so when a recompute removes rows above the selection, the same index now names a **different row**, and the picker could resume the wrong session. Separately, the picker form's snap-back effect (`session-card.tsx`, the `[Spec S03]` selection-invalidation `useLayoutEffect`) checks `ledgerRows.some(r => r.session_id === selection.sessionId)` — the **unfiltered** ledger — so a selected row that is filtered out keeps its (now invisible) selection.
- **Mitigation:**
  - The picker's selection source of truth is already id-based (`PickerSelection = { kind: "session-resume", sessionId }` state + `PickerCellProvider` context; cells derive `isSelected` by id). The fix is confined to the snap-back effect: when a filter is active, test visibility against the *data source projection* (new `SessionsDataSource.hasVisibleSession(sessionId)`) instead of `ledgerRows`, and subscribe the form to the data source version so the effect re-runs per filter recompute. A filtered-away selection snaps to `{ kind: "session-new" }`, which is always present in the picker under any query ([P05]) — so the list never empties and Open always has a meaningful, *visible* target.
  - `/resume` needs no change: its delegate acts on `rowAt(index)` at click/activate time (filtered coordinates), never on a stored id.
- **Residual risk:** the list-view movement *cursor* (not selection) can still land on a different row after a recompute; harmless because every commit path re-reads the row at the acted-on index.

**Risk R02: Lens section filtered to zero rows strands or hides its own filter field** {#r02-lens-empty-reachability}

- **Risk:** Each Lens section gates its list's `focusGroup` on `setSectionHasContent` (`tugdeck/src/components/lens/lens-section-content.ts`) — an empty list is not a focus stop, and `LensContent` skips no-content sections for the ⌘L seed. If the field's reachability were tied to the same gate, filtering to zero would make the field unreachable (can't clear what you can't reach). Also, `LensSection`'s band-click handler (`lens-section-band.tsx`, `onBandClick`) treats any non-button band click as "focus the section's list" — clicking into the field would yank focus away.
- **Mitigation:**
  - The field registers into `host.focusGroup` **unconditionally while the section is expanded**, with `focusPolicy: "skip"` ([P06]) — click-reachable always, in the Tab walk only under accessibility mode, and never the ⌘L seed target (`useSeedKeyView` in `lens-content.tsx` seeds `${sectionFocusGroup(kind)}:0`, and the field registers at `focusOrder: -1`, so the `:0` key still names the list).
  - `onBandClick`'s exclusion selector grows from `"button, .block-grip"` to include the field (`[data-slot="tug-filter-field"]`), so clicks into the field keep their meaning.
  - `setSectionHasContent` publishes the **filtered** count (the data source's `numberOfItems() > 0`), so a filtered-to-zero section correctly drops out of the ⌘L seed and its empty list unregisters; the body renders a distinct "No matches" state (vs. the existing base-empty "None") so the user sees why the section is blank.
- **Residual risk:** in non-accessibility keyboard-only use, reaching a lens filter field requires the mouse (or a11y mode); acceptable — the field is a pointer-first trimming affordance, and Escape/✕ clearing works once focused.

**Risk R03: Snippets section index-mixing under filter** {#r03-snippets-index-mixing}

- **Risk:** Three code paths in `tugdeck/src/components/lens/sections/snippets-section.tsx` mix list indices with the *unfiltered* doc array and would corrupt under a filtered projection: (a) `cursorSnippetId()` reads the cursor cell's `data-tug-list-cell-index` and indexes `snapshot.doc.snippets[idx]`; (b) `deleteSnippetKeepingCursor` computes the landing survivor from `store.getSnapshot().doc.snippets[landing]`; (c) grip reorder's `useBlockReorder` uses `getVisibleOrder: () => snapshot.doc.snippets.map(s => s.id)` and commits `store.setOrder`, which assumes the DOM shows the full doc. Additionally, an *editing* row whose text stops matching the query would vanish mid-edit.
- **Mitigation:** (a)/(b) route through the data source (`dataSource.rowAt(idx)`); (c) grip reorder is disabled while a filter is active (guard + hidden grips, [P07]); the editing row is exempt from filtering via an `editingId` input on the data source ([P07]).
- **Residual risk:** none identified; unit tests on the filtered data source pin all three.

---

### Design Decisions {#design-decisions}

#### [P01] `TugFilterField` composes `TugInput`; `TugFilterFieldDelegate` is an Apple-style synchronous protocol (DECIDED) {#p01-filter-field-delegate}

**Decision:** New tugways component `TugFilterField` (file pair `tug-filter-field.tsx` / `tug-filter-field.css`) wraps a `TugInput` and a trailing clear `TugIconButton` (✕, revealed only when non-empty) in a `data-slot="tug-filter-field"` wrapper. Its behavior contract flows through a delegate object:

```ts
export interface TugFilterFieldDelegate {
  /** REQUIRED. Fires on every input change, and with "" on clear. */
  filterFieldDidChangeQuery(query: string): void;
  /** The ✕ button or Escape-on-non-empty. Fires AFTER the change("") notification. */
  filterFieldDidClear?(): void;
  /** Enter. */
  filterFieldDidSubmit?(query: string): void;
  /** ArrowDown — the host moves the key view to its list ([P10]). */
  filterFieldDidRequestAdvance?(): void;
  /** Escape while already empty — the host may yield focus up its ladder. */
  filterFieldDidRequestDismiss?(): void;
}
```

**Rationale:**
- Mirrors the house delegate doctrine (`tuglaws/lifecycle-delegates.md`): one object, optional methods are no-ops, the framework (here: the field) fires every moment unconditionally. `filterFieldDidChangeQuery` is required because a filter field without a change consumer is meaningless (Apple protocols also mark core methods required).
- Synchronous, no `MessageChannel` drain: a keystroke filter has none of the gesture-focus-lock timing problems the card-lifecycle drain queue exists to solve.
- Composing `TugInput` inherits the substrate CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO responders — a hand-rolled `<input>` goes dead on ⌘A/C/X/V/Z.

**Implications:**
- Props: `placeholder`, `delegate`, `defaultValue?` (uncontrolled; external reset via React `key` remount, [P08]), `focusGroup?` / `focusOrder?` / `focusPolicy?` (forwarded to `TugInput`), `size?` (default `"sm"`), `data-testid?`, `aria-label?`.
- Field-internal behaviors (not delegate methods): full-select on focus gain — `select()` in `onFocus` plus a one-shot `onMouseUp` `preventDefault` guard so WebKit's mouseup does not collapse the selection; Escape-on-non-empty clears in place (DOM value → "", then change + clear notifications) and keeps focus.
- The ✕ is a `TugIconButton` inside the wrapper, absolutely positioned over the input's right padding; hidden at `query === ""` via a `data-empty` attribute + CSS ([L06] — the wrapper flips the attribute from the input event, no React state).

#### [P02] Filtering is a data-source input applied in `recompute()`, not a wrapper (DECIDED) {#p02-filter-in-data-source}

**Decision:** Each adopting data source gains a `filterQuery` input (plus per-source auxiliaries) and applies the shared matcher inside its existing `recompute()`; `rowAt` / `indexForId` / `enabledForIndex` / cursor code all operate in the one filtered coordinate space. The generic `useFilteredDataSource` wrapper is **not** used for these adoptions.

**Rationale:**
- Every adopting consumer's cell renderers are module-level and typed against the concrete data source (`dataSource.rowAt(index)` on `SessionsDataSource`, `LensSnippetsDataSource`, `LensTextFilesDataSource`, the lens `SessionsDataSource`). A wrapper would hand cells a `FilteredTugListViewDataSource` without those extension methods, forcing every cell through `baseIndexFor` translation and captured-base closures — churn and a standing index-confusion hazard (exactly the bug class in [R03]).
- The precedent exists: `SessionsDataSource` already filters in-source via `tagFilter`, and `use-filtered-data-source.ts`'s own docstring sanctions base-layer filtering as a drop-in variant of the [D01] split.
- The [D01] UISearchController split is preserved where it matters: the *host* owns the field and the query; the data source owns enumeration.

**Implications:**
- Each adopting data source's inputs comparison (`setInputsWithoutNotify`) adds the new fields, and unit tests cover the filtered projection directly (the classes are exported and pure).
- **Disposition of `useFilteredDataSource` (state this, don't leave it ambiguous):** after this phase it has exactly one consumer — the gallery filter card. It is **kept, as the sanctioned generic path** for consumers whose cells do not depend on a concrete data-source type (and for future `useSortedDataSource` / `useGroupedDataSource` composition); `gallery-list-view-filter.tsx` is its living contract and its docstring must say so explicitly, naming the in-source alternative and when to pick which. Two filter mechanisms are intentional and documented, not an accident: **wrapper for untyped composition, in-source for typed cells.** If a later phase finds no second wrapper consumer, retiring it is a clean follow-on.

#### [P03] Matching: fuzzy, membership-only, multi-term AND, native order (DECIDED) {#p03-matching-semantics}

**Decision:** Two pure helpers in `src/lib/text-match.ts`, built on the existing `scoreMatch`:

```ts
/** True when EVERY whitespace-separated term of `query` matches (scoreMatch ≠ null) at least ONE of `fields`. Empty/whitespace query → true. */
export function filterQueryMatch(query: string, fields: readonly (string | null | undefined)[]): boolean;

/** Merged, sorted highlight ranges over `text` from every term of `query` that matches `text`. Empty when none match. */
export function filterHighlightRanges(query: string, text: string): ReadonlyArray<readonly [number, number]>;
```

**Rationale:**
- `scoreMatch` already implements the tiers wanted here (exact › prefix › word-prefix › substring › subsequence) with UTF-16 highlight ranges — the "trim what I'm not looking for" behavior is its subsequence tier.
- Multi-term AND (`tug ledger` must hit both terms, each in *some* field) is the cheap, high-value trimming semantic.
- Scores are discarded: user decision (2026-07-24) — native order everywhere; drag-ordered Snippets and persisted-order Lens Sessions must not scramble while typing. Rank-by-score is an explicit follow-on, not a flag in this phase.

**Implications:**
- `filterHighlightRanges` needs a small range-merge (overlapping/adjacent ranges from multiple terms coalesce, sorted ascending) so `<mark>` segments never overlap.
- `matchesTagQuery` (`src/lib/session-tag.ts`) is deleted once `SessionsDataSource` switches over.

#### [P04] Highlights: widen `TugListRow.title` to `React.ReactNode`; one shared renderer; find-paint tokens (DECIDED) {#p04-title-highlight}

**Decision:** `TugListRow`'s `title` prop widens from `string` to `React.ReactNode` — still rendered inside the same `TugLabel` (size/maxLines unchanged), with the presence check switching from `title !== undefined && title !== ""` to the existing `isRenderable` helper. A new shared helper renders highlight fragments:

```ts
// tugdeck/src/components/tugways/filter-highlight.tsx
export function renderFilterHighlight(text: string, query: string): React.ReactNode;
```

returning the plain string when the query is empty or nothing matches (zero-cost unfiltered path), else an array of string segments and `<mark className="tug-filter-mark">` spans per `filterHighlightRanges`. `.tug-filter-mark` styles with the existing find-paint family: `background-color: var(--tugx-find-match-bg); color: inherit;` (`--tugx-find-match-bg` is declared on `body` in `transcript-find.css` as THE one find-match token family per [L17]).

**Rationale:**
- Avoids pushing four cell renderers through `TugListRow`'s `children` escape hatch (house rule 3 in `tuglaws/list-view-usage.md` currently routes `<mark>` results there) — the structured title path keeps typography, truncation, and the subtitle stack.
- One paint family for every find/filter surface means themes tune one token.
- Promotes and retires the gallery's private `renderHighlighted` + inline `MATCH_HIGHLIGHT_STYLE`.

**Implications:**
- **Invariant — ranges are computed against the string actually rendered, never the source field.** `renderFilterHighlight(text, query)` derives its ranges from the `text` argument, so callers MUST pass the exact display string. This is load-bearing: `SessionResumeCell` renders `truncateForDisplay(titleText, 64)`, which both collapses whitespace (`replace(/\s+/g, " ")`) and truncates with an ellipsis — ranges taken from `row.name` would paint at wrong offsets. Every adopting call site passes its already-formatted display string (picker: the truncated snippet; snippets: the incipit; text-files: the basename and the `displayDir`-abbreviated directory).
- **Corollary — a surviving row may legitimately show no marks.** Membership is decided across all of a row's fields (Table T01) while highlighting only paints the fields the row renders, so a row matched on `session_id` or a long `last_user_prompt` tail can survive un-marked. Tests must not assert "every survivor contains a `<mark>`"; they assert marks for a query chosen to hit a rendered field.
- `tuglaws/list-view-usage.md` rule 3 gets amended (highlighted titles are now first-class through `title`; `children` remains for genuinely non-string content) and the consumer inventory updated — done in the docs step.
- Subtitles are highlighted too, once [P11] unifies their rendering.
- Precision note for the presence check: `resolveListRowContentMode` currently tests `title !== undefined && title !== ""`. Widening must NOT collapse to a bare `isRenderable(title)` — `isRenderable("")` is `true`, which would flip an empty-string title from `"empty"` to `"structured"` mode for existing callers. Keep the empty-string guard alongside the node check.

#### [P05] The picker keeps `session-new` under filter; `/resume` keeps dropping it (DECIDED) {#p05-new-row-policy}

**Decision:** `SessionsDataSource` gains a `dropNewRowWhenFiltering: boolean` input. The `/resume` overlay passes `true` (today's behavior: a non-matching query yields a truly empty list that fires no spawn on its pick-to-resume delegate). The full picker passes `false`: the "New session" row stays visible under any query.

**Rationale:**
- In the full picker, dropping the row would NOT prevent an accidental spawn — `submitWith` in `session-card.tsx` already falls to `mode: "new"` when the selection is absent — so keeping the row is the *honest* rendering of what Open will do, and it guarantees the `selectionRequired`-style invariant that the filtered list is never empty ([R01]).
- `/resume`'s empty-on-no-match is a deliberate, documented safety property of that overlay; preserve it.

#### [P06] Lens: `filterable` sections, band-mounted field, transient module store for the query (DECIDED) {#p06-lens-wiring}

**Decision:** `LensSectionDefinition` (`lens-section-registry.ts`) gains `filterable?: boolean`. For a filterable section, `LensSection` (`lens-section-band.tsx`) renders a `TugFilterField` in the band's actions cluster — left of `def.headerActions`, left of the fold chevron, only while expanded (mirroring `headerActions`' `collapsed ? null :` gate) — with placeholder `` `Filter ${def.title}` ``. The query lives in a new transient module store `tugdeck/src/components/lens/lens-filter-store.ts` keyed by section kind (`getFilterQuery(kind)` / `setFilterQuery(kind, q)` / `subscribe` / version), written by the band's delegate adapter and read by the section body via `useSyncExternalStore`, then passed into the section's data source as an input. Field registration: `host.focusGroup`, `focusOrder: -1`, `focusPolicy: "skip"`, NOT gated on `sectionHasContent` ([R02]).

**Rationale:**
- The band and the body are sibling components under `LensSection`; the data source instance is minted inside the body's hook, so the band cannot hand it a delegate directly. A module store is the house [L02] shape for exactly this (cf. `lens-section-content.ts`), and it makes the query survive collapse/expand (the field remounts with `defaultValue={getFilterQuery(kind)}`).
- `focusPolicy: "skip"` keeps three extra Tab stops out of the main lens walk while staying click- and accessibility-reachable.

**Implications:**
- `onBandClick`'s exclusion selector in `lens-section-band.tsx` grows to `"button, .block-grip, [data-slot=\"tug-filter-field\"]"`.
- Not persisted; survives HMR only incidentally (module scope), which is fine for a transient trim.

#### [P07] Snippets under filter: exempt the editing row, disable grip reorder, fix index plumbing (DECIDED) {#p07-snippets-filter-rules}

**Decision:** `LensSnippetsDataSource` inputs become `{ snippets, filterQuery, editingId }`. `recompute()` keeps a row when `filterQueryMatch(filterQuery, [snippet.text])` OR `snippet.id === editingId` (an open editor never vanishes mid-keystroke). While `filterQuery` is non-empty: the grip pointer-down handler is a no-op and grips are hidden via a `data-filter-active` attribute on the list wrap + CSS; `cursorSnippetId()` switches from `snapshot.doc.snippets[idx]` to `dataSource.rowAt(idx)`; `deleteSnippetKeepingCursor` derives its landing survivor from the *filtered* projection (`dataSource.rowAt` on the pre-delete neighbors) instead of `store.getSnapshot().doc.snippets[landing]`.

**Rationale:** closes [R03] wholesale; reorder-while-filtered has no coherent drop semantics against `store.setOrder` (which expects the full visible order) and is a rare gesture — disabling beats a bespoke partial-order merge.

#### [P08] Query resets and lifetime (DECIDED) {#p08-query-lifetime}

**Decision:** Queries are transient, never persisted. The field is uncontrolled (DOM authority); programmatic resets happen by remounting via React `key`. Specifically: the picker's field carries `key={trimmedPath}` so changing the project path clears the filter (a filter for one path's sessions is meaningless for another's); `/resume` and the gallery mount fresh per open; lens fields remount per expand with `defaultValue` from the store.

#### [P09] Trash-all and `nonLiveCount` ignore the filter (DECIDED) {#p09-trash-all-unfiltered}

**Decision:** The picker's Move-all-to-Trash button, its enable gate, and its tooltip ("N sessions, plus all empty sessions") keep reading `nonLiveCount()` — which iterates `inputs.ledger.rows` (the **unfiltered** ledger) — and `trashAll` keeps iterating `ledgerRows`. Filtering the list does not narrow the sweep.

**Rationale:** the sweep is a per-path operation, already documented as broader than the visible list (it also takes empty sessions the wire never carries); silently narrowing it to a filtered subset would make a destructive action's scope depend on a transient text box. `nonLiveCount()` already reads the ledger rows rather than the projected `rows`, so no code change is needed — this decision pins the invariant and adds a test.

#### [P10] ArrowDown hands the key view to the list; Escape ladders (DECIDED) {#p10-keyboard-model}

**Decision:** `filterFieldDidRequestAdvance` implementations call `FocusManager.place`: the picker places `pickerFocusKey(PICKER_ORDER_SESSIONS)` (the existing helper in `session-card.tsx`); a lens band places `` `${sectionFocusGroup(kind)}:0` `` (the same key `onBandClick` uses); `/resume` places the list's stop after Step 5 authors the overlay's list into the sheet's focus group. Escape: non-empty → the field clears itself and **claims the action through the responder chain** (no delegate hand-off of focus) — see Spec S01's mechanism note, which is normative: a `CANCEL_DIALOG` responder, never `stopPropagation`, because bare Escape is a global keybinding the sheet also answers. Empty → the field declines, `filterFieldDidRequestDismiss` fires, and the surface's existing ladder runs (the picker/lens leave the method unimplemented; `/resume` maps it to its close).

#### [P11] `TugListRow` renders BOTH string and node subtitles through `TugLabel` (DECIDED) {#p11-subtitle-unification}

**Decision:** Repair `TugListRow`'s subtitle path before highlighting it. Today the component branches: a **string** subtitle renders `<TugLabel size="sm" emphasis="calm" maxLines={subtitleMaxLines}>`, while a **node** subtitle renders a bare `<span className="tug-list-row-subtitle">`. Delete the branch — every subtitle renders through `TugLabel` (same size / `emphasis="calm"` / `maxLines`), carrying `className="tug-list-row-subtitle"` so the existing selected-state recolor rule keeps matching. Then `subtitle` accepts highlight fragments exactly like `title` ([P04]).

**Rationale:**
- The two paths are a **duplicate implementation of one row line**, and they have already drifted observably: (a) the node branch silently ignores `subtitleMaxLines` (it has no `maxLines` plumbing at all, and `.tug-list-row-subtitle` hard-codes `white-space: nowrap` + ellipsis); (b) the selected-row recolor rule `.tug-list-row[data-selected="true"] .tug-list-row-subtitle` matches ONLY the node branch, because the string branch stamps no such class — so a selected row recolors its subtitle differently depending on which type the caller happened to pass. That is precisely the drift `tuglaws/list-view-usage.md` rule 2 and [L20] exist to prevent.
- Routing highlighting around this defect (title-only) would have made highlighted subtitles a permanent second-class citizen and left the split in place for the next consumer to trip over. Fixing the primitive is the smaller total change.
- **The audit surface is one caller.** A sweep of every `subtitle={…}` call site found exactly ONE passing a node: `sessions-section.tsx`'s pulse `<span>`s. `tug-alert`, `help-sheet`, `agents-sheet`, `skills-sheet`, `memory-sheet`, `permission-mode-chip`, `model-picker-sheet`, `effort-picker-sheet`, `session-question-dialog`, `text-files-section`, and `session-picker-cells` all pass strings.

**Implications:**
- `TugListRowProps.subtitle` keeps its `React.ReactNode` type; only the rendering unifies. `subtitleMaxLines` becomes meaningful for node subtitles (a behavior gain — verify the sessions pulse row still reads as one line, which it will at the default `1`).
- `tug-list-row.css`: `.tug-list-row-subtitle`'s own font-size/color rules must be reconciled with what `TugLabel size="sm" emphasis="calm"` already provides, so the class is left owning only what `TugLabel` does not (the selected-state recolor hook). No new tokens.
- Landing this in Step 2 (with the `title` widening) keeps one commit that touches the primitive, rather than two.

#### [P12] A filtered picker seeds the cursor onto the first real session, not "New session" (DECIDED) {#p12-filtered-seed-index}

**Decision:** While the picker's filter query is non-empty, pass `initialSelectedIndex` = the index of the first `session-resume` row in the filtered projection (a new `SessionsDataSource.firstResumeIndex(): number | undefined`). With an empty query, keep today's behavior (no `initialSelectedIndex`).

**Rationale:**
- The picker's list is `singleSelect`, and on key-view gain the list seeds the cursor onto `initialSelectedIndex` when given, else the **first cursorable row**, and — because `singleSelect` commits live — immediately calls `selectCursorRow`, firing `delegate.onSelect` and overwriting the form's `PickerSelection`.
- The picker passes no `initialSelectedIndex` today, and [P05] keeps "New session" at index 0 under filter. So ArrowDown out of the filter field would seed *and commit* "New session", forcing a second Down press and silently discarding the user's prior selection — the opposite of the intent expressed by typing a filter.
- Seeding the first match is the honest reading of "I typed to narrow this"; "New session" stays one ArrowUp away.

**Implications:** `firstResumeIndex` returns `undefined` when the filtered projection has no resume rows (a query matching nothing), which restores the fall-to-first-cursorable behavior — landing on "New session", correctly.

#### [P13] Ranked order + a compactness gate (DECIDED — supersedes [P03]'s membership-only half) {#p13-ranked-order}

**Decision:** Reverses the native-order half of [P03] after the first build showed it wrong on real data. Two changes, one root cause:

1. **A match must be compact.** `scoreMatch`'s subsequence tier accepts any in-order character run. Over the picker's rows — each carrying a whole `last_user_prompt` — five scattered letters "match" almost any sentence, so a query that should cut ~900 rows to a handful cut nothing (the Lens lists narrowed visibly only because their fields are short). `filterMatchScore` now rejects a match whose span exceeds `MAX_SUBSEQUENCE_SPREAD ×` the characters it matched. Contiguous matches (exact/prefix/word-prefix/substring) have span == length, so the rule never touches them; the acronym cases that motivated fuzzy matching in the first place (`sesldg` → `session-ledger-store`, `pm` → `permissions`) survive.
2. **Filtered rows rank by score.** `filterAndRank` is the one projection every list runs: it drops non-matches and stable-sorts the rest best-first. An empty query returns the input array *by reference*, so an unfiltered list keeps its native order exactly.

**Rationale:** the original decision (user, 2026-07-24) was to keep native order so drag-arranged Snippets and persisted-order Lens Sessions would not scramble while typing. That concern is answered without giving up ranking: reorder gestures are already disabled while a filter is active ([P07]), and the stored order is never rewritten — clearing the query restores it untouched. Meanwhile the cost of discarding the score was a filter that could not do its job on the largest list it was built for.

**Implications:**
- The picker pins `session-new` at index 0 unranked — it is a fixed affordance, not a result. `firstResumeIndex` therefore lands the cursor on the best match ([P12] still holds).
- An edited snippet row is exempt from the filter and unranked, so it leads the list rather than being reshuffled by each keystroke.
- `filterHighlightRanges` applies the same compactness gate, so a row never paints marks from a match too scattered to have kept it.

---

### Deep Dives {#deep-dives}

#### How `TugListView` behaves when the projection shrinks (Risk R01 inspection) {#dd-selection-shrink}

Read from `tugdeck/src/components/tugways/tug-list-view.tsx`:

- In `selectionRequired` mode, `resolveSelectionIndex(current, dataSource)` keeps `current` when still in-range / `"cell"`-role / enabled, else falls to the **first selectable row**, else `null` (transient empty list). So wholesale filtering never crashes or strands selection — but index-keeping means the selection can silently *rebind to a different row* that now occupies the old index.
- The **picker** does not use `selectionRequired`; it uses `singleSelect` (cursor commits selection through the delegate) with consumer-owned `PickerSelection` state read by cells via `PickerCellProvider` — id-based, so the visible selected fill never lies. The only unfiltered-coordinate check is the snap-back effect (fixed per [R01]).
- The lens **Snippets** section uses `selectionRequired` with `initialSelectedIndex` derived from `lastSelectedSnippetId` via `indexForId` — id-based at seed time, positional afterward; acceptable for a trim UX (the fallback is "first surviving row", which is the predictable outcome). Sessions/Text Files lens sections use the default cursor model (no owned selection) — nothing to do.

#### Why the lens field cannot be delegate-wired to the data source directly (Risk R02 / [P06] inspection) {#dd-lens-band-body-split}

`LensContent` builds `LensSectionHost { lensCardId, focusGroup }` per section and hands it to `LensSection`, which renders the band (`BlockStrip`) and, when expanded, the body via `def.body(host)`. The data source hook (`useLensSnippetsDataSource` etc.) runs *inside the body component*; the band renders in a sibling slot and cannot see the instance. Options considered: lifting the data source to `LensSection` (breaks the host-agnostic body contract [P07] of the registry — bodies import nothing from `lens/`), context (same layering problem inverted), or a module store (matches `lens-section-content.ts` precedent, survives collapse). Module store wins; the body passes the query *down into the data source as an input*, which is the same shape the picker uses with React state.

#### Existing focus plumbing the field slots into {#dd-focus-plumbing}

- Picker focus orders (`session-card.tsx`): `PICKER_ORDER_PATH = 0`, `PICKER_ORDER_BROWSE = -0.5`, `PICKER_ORDER_SESSIONS = 2`, `PICKER_ORDER_TRASH_ALL = 3`, `PICKER_ORDER_CANCEL = 4`, `PICKER_ORDER_OPEN = 5`, all in `PICKER_CYCLE_GROUP` with `pickerFocusKey(order)` minting focus keys. The filter field takes new `PICKER_ORDER_FILTER = 1`.
- Lens: the list registers `focusGroup={hasContent ? host.focusGroup : undefined}` (default order 0); the ⌘L seed and band click both target `` `${group}:0` ``. A field at `focusOrder: -1` coexists without disturbing either.
- `/resume` (`resume-sheet.tsx`): the sheet mints `focusGroup = useId()` and seeds `${focusGroup}:0` onto the field; the list is currently unauthored (mouse-only). Step 5 authors it at `focusOrder: 1` with `commitOnEnter="act"` + an `onActivate` mirroring `onSelect`, giving the overlay its first keyboard path to rows.

#### Per-surface filter fields (what each row matches against) {#dd-filter-fields}

**Table T01: Filter-field inputs per data source** {#t01-filter-fields}

| Data source | Row | Matched fields |
|---|---|---|
| `SessionsDataSource` (`session-picker-data-source.ts`) | `session-resume` | `row.name`, `row.tag` or `deriveStableTag(session_id)` when untagged, `row.last_user_prompt`, `row.session_id` |
| | `session-new` / `loading` | exempt: kept per [P05] policy flag / kept while pending |
| lens `SessionsDataSource` (`sessions-data-source.ts`) | `MonitorRow` | `sessionCardTitleOverride(projectDir, name, tag, null)` — the same label the cell shows (branch omitted: it's per-cell git state, not in the DS) — plus `basename(projectDir)` |
| `LensSnippetsDataSource` | `Snippet` | `snippet.text` |
| `LensTextFilesDataSource` | `TextFilesRow` | `title` (basename) and the **displayed** directory — the `~`-abbreviated form, per the note below |

**Directory matching for Text Files.** The abbreviation helper `displayDir` (`/Users/<name>` → `~`) currently lives in `text-files-section.tsx`, while the data source owns `basename`; the cell derives its subtitle as `displayDir(dirname(row.path))`. Move `displayDir` into `text-files-data-source.ts` beside `basename` and have the section import it from there, so the data source matches **exactly the string the row displays**. This matters both ways: it satisfies the [P04] rendered-string invariant for subtitle highlighting, and it makes a typed `~/src` find the row (matching the raw `/Users/…` path would not).

The lens sessions data source reads `sessionNameStore.getName(id)` / `sessionTagStore.getTag(id)` at recompute time; to re-filter when a name/tag arrives late, the section body subscribes to both stores (`useSyncExternalStore` on their versions) and passes the versions as data-source inputs — same didChange/notify pattern the hooks already use.

---

### Specification {#specification}

**Spec S01: `TugFilterField` behavior contract** {#s01-filter-field-behavior}

1. Rendering: `<div data-slot="tug-filter-field" data-empty={…}>` wrapping a `TugInput` (`size="sm"` default) and a ✕ `TugIconButton` (`aria-label="Clear filter"`), ✕ visible only when non-empty (CSS off `data-empty`, [L06]).
2. Every input change → `filterFieldDidChangeQuery(value)` synchronously. No debounce.
3. Focus gain (click or keyboard) → contents fully selected; the first mouseup after a focusing mousedown is `preventDefault`ed so WebKit doesn't collapse the selection.
4. ✕ click → DOM value `""`, `filterFieldDidChangeQuery("")`, then `filterFieldDidClear()`; focus returns to the input.
5. Escape: non-empty → same as ✕ (clear in place, keep focus, and the surrounding sheet/section must NOT also dismiss); empty → `filterFieldDidRequestDismiss()` and the surface's own Escape ladder runs.

   **Mechanism (do not hand-roll this).** A React `onKeyDown` + `stopPropagation` is the wrong tool: `keybinding-map.ts` maps bare `Escape` → `TUG_ACTIONS.CANCEL_DIALOG` globally (deliberately without `preventDefaultOnMatch`), and `TugInput` / `useTextInputResponder` handle no such action — so the picker sheet would dismiss out from under a filter the user meant to clear. The sanctioned path is the responder chain: `ResponderChain.resolveKeybinding` walks scope-local bindings **from the first responder upward** before falling through to the static global map, so `TugFilterField` registers its own responder (`useResponder`) handling `CANCEL_DIALOG`: **clear and claim** when the query is non-empty, **decline** (let the walk continue to the sheet's / card's handler) when empty. See `tuglaws/responder-chain.md` and the "Chain-reactive dismissal" section of `tuglaws/component-authoring.md`.
6. Enter → `filterFieldDidSubmit(value)`; does not propagate.
7. ArrowDown → `filterFieldDidRequestAdvance()`; does not propagate when the delegate implements it.
8. Uncontrolled; `defaultValue` seeds; external reset by `key` remount ([P08]).

**Spec S02: matcher semantics** {#s02-matcher-semantics}

- `filterQueryMatch("", anything)` → `true` (no filter). Terms = query trimmed and split on `/\s+/`.
- A row passes iff every term has `scoreMatch(term, field) !== null` for at least one non-null field. Case folding and coordinates are `scoreMatch`'s (Unicode default lowercase, UTF-16 ranges).
- `filterHighlightRanges(query, text)`: union of `scoreMatch(term, text).matches` over terms that match `text`, sorted, overlapping/adjacent ranges merged. Empty array when query is empty or no term matches.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Field text + ✕ visibility | appearance (DOM authority) | uncontrolled `<input>` value + `data-empty` attribute flipped in the input handler | [L06] |
| Field's Escape claim | structure (chain registration) | `useResponder` `CANCEL_DIALOG` handler, installed in `useLayoutEffect` | [L03], [L11] |
| Picker filter query | local UI data | `useState` in the picker form; delegate adapter writes it; flows into `SessionsDataSource` as an input | [L24] |
| `/resume` filter query | local UI data | existing `useState` in `ResumeSheetBody`, unchanged home | [L24] |
| Lens per-section query | external module state | `lens-filter-store.ts` (Map + version + listeners); band writes, body reads via `useSyncExternalStore` | [L02] |
| Filtered projections | external store (data source) | each data source recomputes in `setInputsWithoutNotify` → `notifyAll` from `useLayoutEffect` | [L02], [L03] |
| Grip-hidden-while-filtered | appearance | `data-filter-active` on the snippets list wrap + CSS | [L06] |
| Section has-content (now filtered) | external module state | existing `lens-section-content.ts`, value source changes to filtered count | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-filter-field.tsx` | `TugFilterField`, `TugFilterFieldDelegate`, props type |
| `tugdeck/src/components/tugways/tug-filter-field.css` | wrapper/✕ layout, `data-empty` reveal, `.tug-filter-mark` paint |
| `tugdeck/src/components/tugways/filter-highlight.tsx` | `renderFilterHighlight(text, query)` |
| `tugdeck/src/components/lens/lens-filter-store.ts` | transient per-section query store |
| `tugdeck/src/components/tugways/__tests__/filter-highlight.test.tsx` | highlight renderer tests |
| `tugdeck/src/lib/__tests__/text-match-filter.test.ts` | `filterQueryMatch` / `filterHighlightRanges` tests |
| `tests/app-test/at0265-picker-filter.test.ts` | picker filter app-test (AT0265 — register the tag in `tuglaws/app-test-inventory.md` first) |
| `tests/app-test/at0266-lens-filter.test.ts` | lens snippets filter app-test (AT0266 — same registration rule) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `filterQueryMatch`, `filterHighlightRanges` | fn | `src/lib/text-match.ts` | [P03], Spec S02 |
| `TugFilterField`, `TugFilterFieldDelegate` | component/interface | `tug-filter-field.tsx` | [P01], Spec S01; owns a `CANCEL_DIALOG` responder |
| `renderFilterHighlight` | fn | `filter-highlight.tsx` | [P04] |
| `TugListRowProps.title` | prop widening `string → React.ReactNode` | `tug-list-row.tsx` | [P04]; keep the `!== ""` guard in `resolveListRowContentMode` |
| `TugListRow` subtitle rendering | unify branch → single `TugLabel` | `tug-list-row.tsx` / `tug-list-row.css` | [P11] |
| `SessionsInputs.query → projectDir`, `tagFilter → filterQuery`, `+ dropNewRowWhenFiltering` | rename/add | `src/lib/session-picker-data-source.ts` | [P02], [P05]; the rename removes a `query`(=path) vs `filterQuery` collision |
| `SessionsDataSource.hasVisibleSession` | method | `src/lib/session-picker-data-source.ts` | [R01] |
| `SessionsDataSource.firstResumeIndex` | method | `src/lib/session-picker-data-source.ts` | [P12] |
| `displayDir` | move `text-files-section.tsx` → `text-files-data-source.ts` | lens text-files pair | Table T01 |
| `matchesTagQuery` | **delete** | `src/lib/session-tag.ts` | replaced by `filterQueryMatch` |
| `PICKER_ORDER_FILTER = 1` | const | `session-card.tsx` | [P10], (#dd-focus-plumbing) |
| `LensSectionDefinition.filterable` | field | `lens-section-registry.ts` | [P06] |
| `getFilterQuery` / `setFilterQuery` / `subscribeFilterQuery` / `getFilterVersion` | fns | `lens-filter-store.ts` | [P06] |
| `LensSnippetsDataSource` inputs `{ snippets, filterQuery, editingId }` | change | `snippets-data-source.ts` | [P07] |
| lens `SessionsDataSource` inputs `+ filterQuery, nameVersion, tagVersion` | change | `sessions-data-source.ts` | Table T01 |
| `LensTextFilesDataSource` inputs `+ filterQuery` | change | `text-files-data-source.ts` | Table T01 |
| `onBandClick` exclusion selector | change | `lens-section-band.tsx` | [R02] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/list-view-usage.md`: amend rule 3 (highlighted **titles and subtitles** are first-class via the widened `title` / unified subtitle per [P04]/[P11]; `children` stays for genuinely non-string content), note the unified subtitle contract under rule 2, and update the consumer inventory rows that gain filtering.
- [ ] `tuglaws/app-test-inventory.md`: add the **AT0265** (picker filter) and **AT0266** (lens filter) tags — done inside #step-5 / #step-8, before their test files are named, per the inventory's numbering invariant.
- [ ] Module docstrings on every new file per [L19]; `TugFilterField` docstring documents both sanctioned wirings (React-state adapter vs. module-store adapter), the delegate contract, and the `CANCEL_DIALOG` responder.
- [ ] `gallery-list-view-filter.tsx` docstring states the [P02] disposition: it is the living contract for the `useFilteredDataSource` wrapper path, and when to choose wrapper vs. in-source filtering.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | pure matchers, highlight ranges/renderer, each data source's filtered projection (real class instances, real inputs) | Steps 1, 2, 4, 7 |
| **App-test** | the real picker and lens driven in the real app: type → narrow → act | Steps 5, 8 |
| **Integration checkpoint** | tsc + vite build + full bun test + full app-test sweep | Step 9 |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests of `TugFilterField` and no mock-store assertions (banned patterns — "real, not fake"); the component's behavior is covered by the app-tests driving the real picker/lens, and its pure parts (highlight renderer, matchers) are unit-tested directly.
- Keyboard select-all-on-focus and the mouseup guard — WebKit gesture nuances that a headless sweep can't faithfully reproduce (cf. the app-test first-responder limits memory); verified manually in the debug app.
- `/resume` end-to-end — its overlay lives in short-lived real-scribe flows that aren't app-testable (transient workspace); covered at the data-source unit layer plus the picker app-test exercising the same cells.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step. All paths below are relative to the repo root; `bun`/`bunx` commands run in `tugdeck/`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Pure matchers in text-match | done | 327c27d18 |
| #step-2 | TugFilterField + delegate + highlight renderer + TugListRow title/subtitle repairs | done | 16fe6fcce |
| #step-3 | Gallery card converts to TugFilterField | done | 3c296f577 |
| #step-4 | SessionsDataSource: fuzzy filterQuery + /resume adoption | done | 6c1a02822 |
| #step-5 | Picker adoption + app-test | done | da571a1b2 |
| #step-6 | Lens plumbing: registry flag, band field, filter store | done | 5e8024dec |
| #step-7 | Lens data sources filter + snippets safety fixes | done | 56e3d4e9c |
| #step-8 | Lens app-test | done | 34201aca3 |
| #step-9 | Integration checkpoint + docs | done | 3447ee3b4 |

#### Step 1: Pure matchers in text-match {#step-1}

**Commit:** `tugdeck(text-match): add filterQueryMatch + filterHighlightRanges fuzzy filter helpers`

**References:** [P03] matching semantics, Spec S02, (#dd-filter-fields)

**Artifacts:**
- `filterQueryMatch`, `filterHighlightRanges`, and a private range-merge in `tugdeck/src/lib/text-match.ts`; new test file `text-match-filter.test.ts`.

**Tasks:**
- [ ] Implement per Spec S02 on top of the existing `scoreMatch`; document in the module docstring that these are the list-filter entry points and scores are membership-only.
- [ ] Range merge: sort by start, coalesce overlapping/adjacent, return readonly tuples.

**Tests:**
- [ ] Empty/whitespace query passes everything; multi-term AND across different fields; subsequence tier (`sesldg` ↦ `session-ledger-store`); null/undefined fields skipped; case folding.
- [ ] Highlight ranges: single term, two terms overlapping (merged), term matching only one of several fields, empty on no match.

**Checkpoint:**
- [ ] `bun test src/lib/__tests__/text-match-filter.test.ts` green; `bunx tsc --noEmit` green.

---

#### Step 2: TugFilterField + delegate + highlight renderer + TugListRow title/subtitle repairs {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(filter-field): TugFilterField + delegate, shared filter highlight, unified list-row title/subtitle rendering`

**References:** [P01] component+delegate, [P04] title highlight + rendered-string invariant, [P11] subtitle unification, [Q01] (resolved by [P11]), Spec S01, [Q03]/[P10] keyboard model, (#s01-filter-field-behavior, #p11-subtitle-unification)

**Artifacts:**
- `tug-filter-field.tsx` / `.css`, `filter-highlight.tsx` + test, and both `TugListRow` repairs (`title: React.ReactNode`; subtitle branch unified) in `tug-list-row.tsx` / `tug-list-row.css`.

**Tasks:**
- [ ] Build per Spec S01: `TugInput` composition (forwarding `focusGroup`/`focusOrder`/`focusPolicy`), ✕ `TugIconButton`, `data-empty` attribute flip, select-all-on-focus with the one-shot mouseup guard, Enter/ArrowDown delegate routing, and the **`CANCEL_DIALOG` responder** for Escape per Spec S01's mechanism note (claim when non-empty, decline when empty).
- [ ] `.tug-filter-mark { background-color: var(--tugx-find-match-bg); color: inherit; }` plus wrapper layout in `tug-filter-field.css`; declare pairings per [L16]/component-authoring.
- [ ] `renderFilterHighlight` per [P04]: plain string fast path; segments + `<mark>` otherwise.
- [ ] Widen `title` in `tug-list-row.tsx`: type change, JSDoc updated, and keep the empty-string guard in `resolveListRowContentMode` (see [P04] precision note — a bare `isRenderable` would reclassify `title=""`). Grep-verify existing callers pass strings.
- [ ] [P11]: delete the string-vs-node subtitle branch — one `TugLabel` (`size="sm"`, `emphasis="calm"`, `maxLines={subtitleMaxLines ?? 1}`, `className="tug-list-row-subtitle"`) for both. Reconcile `.tug-list-row-subtitle` in `tug-list-row.css` down to what `TugLabel` does not already provide (keep the selected-state recolor hook; drop the now-duplicated font-size/color/nowrap if `TugLabel` covers them).
- [ ] Verify the ONE node-subtitle caller — `sessions-section.tsx`'s pulse `<span>`s — still renders as a single muted line (it now honors `subtitleMaxLines`, default `1`), and that a *selected* row recolors its subtitle identically for string and node callers (the pre-existing asymmetry [P11] documents).

**Tests:**
- [ ] `filter-highlight.test.tsx`: empty query returns the identical string; segment boundaries exact against known ranges; merged ranges produce non-overlapping marks.
- [ ] `tug-list-row` content-mode unit: `title=""` still resolves `"empty"`; a node title resolves `"structured"`; `children` still wins over both.

**Checkpoint:**
- [ ] `bun test` green; `bunx tsc --noEmit` green; `bunx vite build` green.
- [ ] Visual pass in the debug app on a list with a node subtitle (Lens Sessions) and string subtitles (picker), selected and unselected, confirming one consistent subtitle treatment.

---

#### Step 3: Gallery card converts to TugFilterField {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(gallery): filter card composes TugFilterField + shared highlight`

**References:** [P01], [P04], [P02] (the gallery keeps demoing the `useFilteredDataSource` wrapper path), (#context)

**Artifacts:**
- `gallery-list-view-filter.tsx` uses `TugFilterField` (delegate adapter writing its `query` state) and `renderFilterHighlight`; private `renderHighlighted` + `MATCH_HIGHLIGHT_STYLE` deleted; docstring updated to name the card as `TugFilterField`'s showcase.

**Tasks:**
- [ ] Swap input; keep the wrapper-based filtering (this card intentionally demos the generic composition path, unlike the product surfaces' in-source filtering — note this contrast in the docstring).

**Checkpoint:**
- [ ] `bunx tsc --noEmit` + `bunx vite build` green; manual: gallery card filters, highlights, ✕ clears, focus-select works.

---

#### Step 4: SessionsDataSource — fuzzy `filterQuery` + `/resume` adoption {#step-4}

**Depends on:** #step-2

**Commit:** `tugdeck(session-picker): fuzzy filterQuery in SessionsDataSource, /resume adopts TugFilterField, retire matchesTagQuery`

**References:** [P02] filter-in-data-source, [P03], [P04] rendered-string invariant, [P05] new-row policy, [P10] keyboard, [P11] subtitle rendering, [P12] seed index, Table T01, Risk R01, (#dd-focus-plumbing)

**Artifacts:**
- `session-picker-data-source.ts`: **`query` → `projectDir`** (the field means "the typed project path" and gates `isReady()`/`isPending()`; leaving it named `query` beside a new `filterQuery` is a readability trap), `tagFilter` → `filterQuery` (+ `dropNewRowWhenFiltering`), matcher swapped to `filterQueryMatch` over Table T01's fields, new `hasVisibleSession(sessionId)` and `firstResumeIndex()`; `useSessionsDataSource` signature updated at both call sites.
- `session-tag.ts`: `matchesTagQuery` deleted (and its test coverage moved/retired).
- `resume-sheet.tsx`: `TugInput` → `TugFilterField` (delegate adapter over the existing `filterQuery` state, `dropNewRowWhenFiltering: true`); the list authored into the sheet's focus group (`focusOrder: 1`) with `commitOnEnter="act"` and `onActivate` mirroring `onSelect`; ArrowDown advance places the list's stop.

**Tasks:**
- [ ] Keep the existing content-visibility filter (file_size/turn_count/live) exactly as-is; the fuzzy filter composes with it.
- [ ] `SessionResumeCell` (`session-picker-cells.tsx`): highlight BOTH lines — `title={renderFilterHighlight(snippet, filterQuery)}` and `subtitle={renderFilterHighlight(subtitleText, filterQuery)}` ([P11] makes the subtitle path safe). Per the [P04] invariant, pass the already-formatted display strings (`snippet` is the `truncateForDisplay(…, 64)` output, `subtitleText` the composed metadata line) — never the raw `row.name` / field values.
- [ ] The cell reads the query from `PickerCellProvider` context: add `filterQuery: string` to the context value and set it at BOTH providers (`/resume` passes its query now; the picker passes `""` until Step 5 wires its own).
- [ ] Guard the empty-query path: `renderFilterHighlight` must return the bare string so unfiltered rows render exactly as today (no wrapper spans).

**Tests:**
- [ ] Data-source units: fuzzy narrowing over name/tag/derived-tag/prompt/id; `dropNewRowWhenFiltering` both ways; `hasVisibleSession` respects the filter; `firstResumeIndex` skips `session-new` and returns `undefined` on a no-match query; empty query ≡ today's rows.

**Checkpoint:**
- [ ] `bun test` green; `bunx tsc --noEmit` + `bunx vite build` green; grep confirms `matchesTagQuery` has zero references.

---

#### Step 5: Picker adoption + app-test {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(session-card): filter field on the picker's Sessions line`

**References:** [P05], [P08] path-keyed reset, [P09] trash-all unfiltered, [P10], [P12] seed index, Risk R01, Spec S01, (#dd-focus-plumbing, #dd-selection-shrink)

**Artifacts:**
- `session-card.tsx`: `PICKER_ORDER_FILTER = 1`; `filterQuery` state + delegate adapter; `TugFilterField` right-aligned on the `.session-card-picker-label` "Sessions" line (`key={trimmedPath}`, placeholder "Filter sessions", coexisting with the scanning indicator); query into `useSessionsDataSource` and into `PickerCellProvider`; snap-back effect switched to `hasVisibleSession` + a `useSyncExternalStore` subscription on the data source; `initialSelectedIndex={filterQuery !== "" ? sessionsDataSource.firstResumeIndex() : undefined}` per [P12]; ArrowDown advance → `pickerFocusKey(PICKER_ORDER_SESSIONS)`.
- `session-card.css` (or the picker's stylesheet): label line becomes a flex row, field ~200px, spacing tokens.
- **AT0265** — new app-test `at0265-picker-filter.test.ts`, plus its entry in `tuglaws/app-test-inventory.md` (the inventory's numbering invariant: *add the tag first, then name the test*; highest test on disk today is `at0264`). Harness patterns from `at0141-picker-keys.test.ts` apply.

**Tasks:**
- [ ] Add the AT0265 inventory entry BEFORE creating the test file.
- [ ] Confirm [P09] by test: with a filter active, the trash-all label/tooltip count and disable gate are unchanged.
- [ ] Verify Enter-in-field (`filterFieldDidSubmit`) does nothing surprising — the picker's default action stays with Open; leave submit unimplemented.
- [ ] Re-read `at0141-picker-keys.test.ts` after inserting `PICKER_ORDER_FILTER = 1`: it walks the cycle with the tolerant `tabUntil` helper (no hard-coded hop counts), but its module docstring narrates the exact stop sequence and must be updated to include the filter field between the path field and Sessions.

**Tests:**
- [ ] App-test AT0265, written **host-state-independently** — the picker's rows come from tugcast's ledger + JSONL scan of real host state, and `at0141` is explicitly built to tolerate that variability, so do NOT assert absolute row counts. Instead: capture the pre-filter row count, type a fragment drawn from a row title actually present in that snapshot, then assert (a) post-filter count < pre-filter count, (b) every surviving `session-resume` row's title matches the fragment case-insensitively, (c) at least one `<mark>` is painted (the fragment came from a rendered title, so [P04]'s corollary does not bite), (d) ArrowDown from the field lands the cursor on a `session-resume` row, not "New session" ([P12]), (e) a deliberately absent fragment leaves only "New session", and (f) ✕ restores the original count.
- [ ] If a future need makes deterministic rows necessary, the sanctioned seeding path is writing real JSONL transcripts into the encoded claude project dir for a temp path before launch (the scan picks them up) — real files, real scan, no mocks.

**Checkpoint:**
- [ ] `just app-test` (AT0265 + `at0141-picker-keys` regression) green; `bunx vite build` green.

---

#### Step 6: Lens plumbing — registry flag, band field, filter store {#step-6}

**Depends on:** #step-2

**Commit:** `tugways(lens): filterable sections — band-mounted TugFilterField + transient filter store`

**References:** [P06] lens wiring, [P08], [P10], Risk R02, (#dd-lens-band-body-split, #dd-focus-plumbing)

**Artifacts:**
- `lens-filter-store.ts` (+ inline unit coverage if any non-trivial logic; it's a Map+version store mirroring `lens-section-content.ts`).
- `lens-section-registry.ts`: `filterable?: boolean` on `LensSectionDefinition`.
- `lens-section-band.tsx`: field rendered when `def.filterable && !collapsed`, placeholder `` `Filter ${def.title}` ``, `defaultValue={getFilterQuery(def.kind)}`, delegate adapter writing the store, registration `host.focusGroup` / `focusOrder: -1` / `focusPolicy: "skip"`, advance → place `` `${sectionFocusGroup(def.kind)}:0` ``; `onBandClick` exclusion selector extended with `[data-slot="tug-filter-field"]`.

**Tasks:**
- [ ] Field is independent of `sectionHasContent` — verify a zero-content section still renders and focuses its field ([R02]).
- [ ] **Band geometry.** The band's line box is `--tugx-toolheader-line: calc(var(--tug-font-size-sm) * 1.75)` (≈23px) with `--tug-space-sm` block padding, while `TugInput size="sm"` is a fixed `1.75rem` (28px) — the bands WILL grow a few px. Confirm that reads acceptably at the Lens's real width (~370px in the reference screenshot) for all three bands, and if the growth is objectionable, shrink the field via its own `--tugx-filter-field-height` alias rather than overriding `TugInput`'s internals ([L20]).
- [ ] **Band width.** Specify the field's sizing explicitly rather than leaving it to CSS improvisation: `flex: 1 1 auto` with a `min-width` sized to hold the longest placeholder (`Filter Text Files`), so grip + glyph + title + field + actions + chevron still fit. Verify the longest title (`Text Files`) plus the `+` action (Snippets) at that width.

**Tests:**
- [ ] Unit: `lens-filter-store` set/get/subscribe/version; query survives a simulated collapse (store retains value with no subscribers).

**Checkpoint:**
- [ ] `bun test` + `bunx tsc --noEmit` + `bunx vite build` green; manual: band click still focuses the list, click-in-field doesn't, and Escape in a non-empty field clears it without collapsing/dismissing anything (Spec S01 chain mechanism).

---

#### Step 7: Lens data sources filter + snippets safety fixes {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(lens): fuzzy filtering in Sessions/Snippets/Text Files sections, snippets filtered-index hardening`

**References:** [P02], [P03], [P07] snippets rules, Table T01, Risks R02–R03, (#dd-filter-fields)

**Artifacts:**
- `snippets-data-source.ts`: inputs `{ snippets, filterQuery, editingId }`, filtered `recompute` with editing-row exemption.
- `sessions-data-source.ts`: inputs + `filterQuery`, `nameVersion`, `tagVersion`; recompute matches `sessionCardTitleOverride(projectDir, name, tag, null)` + `basename(projectDir)`.
- `text-files-data-source.ts`: inputs + `filterQuery`; recompute matches title + directory display string.
- `text-files-data-source.ts` also **absorbs `displayDir`** from `text-files-section.tsx` (Table T01's directory-matching note); the section imports it from the data source module.
- Section bodies (`snippets-section.tsx`, `sessions-section.tsx`, `text-files-section.tsx`): read the store query, pass into the DS hooks, mark `filterable: true` in their `registerLensSection` calls, publish `setSectionHasContent` from the **filtered** count, render "No matches" (distinct from the base-empty "None") when base non-empty but filtered empty, and highlight via `renderFilterHighlight` on BOTH lines — titles (snippets incipit, text-file basename, session label) and subtitles (text-file `displayDir` directory), now that [P11] makes subtitles a first-class highlight target. Per [P04], each call passes the exact display string the row renders.
- `snippets-section.tsx` hardening per [P07]: `cursorSnippetId` via `dataSource.rowAt`; `deleteSnippetKeepingCursor` survivor from the filtered projection; grip no-op + `data-filter-active` grip hiding while filtered.

**Tests:**
- [ ] Snippets DS: filter narrows by text; editing row exempt; `indexForId` in filtered coordinates; delete-survivor derivation under filter.
- [ ] Lens sessions DS: matches label and dirname; recompute on name/tag version bump.
- [ ] Text-files DS: matches basename and directory.

**Checkpoint:**
- [ ] `bun test` + `bunx tsc --noEmit` + `bunx vite build` green.

---

#### Step 8: Lens app-test {#step-8}

**Depends on:** #step-7

**Commit:** `test(app): lens section filtering — narrow, highlight, clear, empty-state reachability`

**References:** Risks R02–R03, [P06], [P07], [P11], (#success-criteria); harness precedents `at0248-lens-list-cursor-keys`, `at0254-lens-snippet-editor-growth` (snippet creation in app-tests is established there, so this list CAN be seeded deterministically — unlike the picker's host-derived rows in #step-5).

**Artifacts:**
- **AT0266** — `at0266-lens-filter.test.ts`, plus its entry in `tuglaws/app-test-inventory.md` added FIRST (numbering invariant).

**Tasks:**
- [ ] Add the AT0266 inventory entry before creating the test file.

**Tests:**
- [ ] Seed snippets → type into the Snippets band field → rows narrow with `<mark>` in survivors → filter to zero → "No matches" visible, field still clickable/clearable, ⌘L seed skips the section ([R02]) → ✕ → rows restored, cursor keys still walk the list.
- [ ] Escape in a non-empty lens filter field clears it and does NOT collapse the section or exit the Lens (Spec S01 chain mechanism).

**Checkpoint:**
- [ ] `just app-test` green including AT0266 and the existing lens tests (`at0245`, `at0248`, `at0254`–`at0257`).

---

#### Step 9: Integration checkpoint + docs {#step-9}

**Depends on:** #step-3, #step-5, #step-8

**Commit:** `docs(tuglaws): list-view usage — filtered titles + consumer inventory` (docs only; verification otherwise)

**References:** [P04], Documentation Plan (#documentation-plan), (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] `tuglaws/list-view-usage.md` amendments per the Documentation Plan.
- [ ] Full sweep: `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `cd tugrust && cargo nextest run` (should be untouched; confirms no accidental cross-tree edits), `just app-test`.
- [ ] Manual pass in the debug app: picker filter feel (select-all on click-in, live narrowing, ✕), all three lens sections, `/resume` overlay.

**Checkpoint:**
- [ ] All commands green; every Success Criteria bullet demonstrably true.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `TugFilterField` + `TugFilterFieldDelegate` shipped in tugways, with fuzzy, highlight-painting, order-preserving filtering live in the Session picker, the `/resume` overlay, and all three Lens sections — the three pre-existing bespoke filter paths (tagFilter/matchesTagQuery, gallery-private highlighting) retired onto the shared machinery, and `TugListRow`'s two text lines repaired into one rendering contract ([P04]/[P11]) so highlights compose into either line without an escape hatch.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every Success Criteria bullet verified (#success-criteria).
- [ ] `matchesTagQuery` deleted; grep-clean.
- [ ] `TugListRow` has ONE subtitle rendering path: grep confirms no bare `span.tug-list-row-subtitle` branch remains, and `subtitleMaxLines` is honored for string and node subtitles alike ([P11]).
- [ ] No new persistence: grep confirms no tugbank/localStorage writes from filter code.
- [ ] `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `cargo nextest run`, `just app-test` all green.

**Acceptance tests:**
- [ ] `at0265-picker-filter` and `at0266-lens-filter` green in the sweep, and both tags present in `tuglaws/app-test-inventory.md`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Filter-aware collapsed summaries ("3 of 12", [Q02]).
- [ ] Per-list opt-in rank-by-score ordering.
- [ ] Adoption by the sheet lists (help/skills/agents/model picker) and any future long list.

| Checkpoint | Verification |
|------------|--------------|
| Component + matchers | `bun test` (steps 1–2 suites) |
| Picker flow | `at0265-picker-filter` |
| Lens flow | `at0266-lens-filter` |
| Full sweep | Step 9 command list |
