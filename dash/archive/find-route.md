<!-- devise-skeleton v4 -->

## Find Route — Transcript Search in the Dev Card {#find-route}

**Purpose:** Add a **Find** route to the Dev card's prompt entry — a live, incremental
text search over the transcript with a whole-transcript "N of M" count, all matches
highlighted, Next/Previous navigation with wrap, Case-sensitive / Entire-word / Grep
toggles, and a landing flash on each match — reachable by ⇧⌘F or the route popup.

> **Authoring note (why this plan was rewritten).** The first version of this plan was
> discarded before implementation because it (a) invented a bespoke `rowSearchText`
> projection and `markdownToPlainText` reducer that **duplicate existing machinery**
> (`@/lib/markdown/parse-markdown-to-sanitized-blocks`, `@/lib/markdown/serialize-selection`);
> (b) wrote Spec S07 against a subscribe surface on `ToolBlockExpansionState` that **does
> not exist**; and (c) **deferred the load-bearing crux** (match ↔ virtualized-DOM
> mapping + count fidelity) to the middle of the build behind two steps of scaffolding.
> This version is grounded in the real code and is sequenced **risk-first**: Step 1 is a
> thin end-to-end find that *proves* the crux on real content before anything else is
> built.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | superseded by [find-foundations.md](find-foundations.md) — Steps 1–4 landed in `3bf91cbd`; Steps 5–6 replaced |
| Target branch | main |
| Last updated | 2026-07-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Dev card's prompt entry is a data-driven **route** system: the same editor flips
between `❯` Code, `$` Shell, and `?` btw by writing one string onto a per-entry
`RouteLifecycle` (`@/lib/route-lifecycle`). Routes are declared as data across small
lookup tables in `tug-prompt-entry.tsx` — there is no central switch. None searches the
transcript today; the only find surfaces are CodeMirror-internal (a Text card's reveal
flash, `tug-code-view`'s search ping), and the `⌘F` keybinding is a stub owned leaf-first
by whichever CM6 editor holds find.

We want Find to be the transcript's search. The transcript is **not** CodeMirror — it is a
custom virtualized list (`TugListView` over `DevTranscriptDataSource`), and I confirmed
`OVERSCAN_COUNT = 3`, so at any moment almost every row is **unmounted**. That single fact
defines the hard problem and this plan's shape: a whole-transcript "N of M" count cannot
come from the DOM (most rows aren't there), so it must come from a **store→text index**
over every row; but *painting* a match can only touch mounted DOM, so paint is a separate,
repaint-on-scroll concern. Counting and painting are decoupled and must be kept in
agreement. This is the crux, and Step 1 exists to prove it.

#### Strategy {#strategy}

- **Prove the crux first (risk-first).** Step 1 is a working end-to-end find on real
  transcript content: store→text index → search → whole-transcript count → Custom-Highlight
  paint of mounted matches → Enter navigates + scrolls. Everything else (options, wrap,
  flash polish, expanded-editor scope) hardens a loop already proven to work.
- **Reuse, do not reinvent.** The store→text index reuses the shared parse cache
  (`ensureParsed`, the same parses `TugMarkdownBlock` warmed), so projected text tracks
  rendered text at cache-hit cost. Painting reuses the CSS Custom Highlight mechanism
  already proven in `selection-guard.ts`. Embedded-editor find reuses `tug-code-view`'s CM6 search.
- **Count from the store index, paint from the DOM.** The index over all rows is the
  authoritative match set + "N of M" ([P02]); the painter resolves DOM Ranges for the
  ~handful of mounted rows and repaints as the window changes.
- **Keep appearance out of React.** Highlighting, the landing flash, and the wrap graphic
  are imperative Custom Highlight / CSS / Web-Animations work ([L06]); only query, options,
  matches, and active index are store state read via `useSyncExternalStore` ([L02]).
- **Additive route.** `⌕` Find slots into the existing route tables; `⇧⌘F` is its entry
  chord in the ⇧⌘C/S/B family; plain `⌘F` is left editor-owned ([P07]).

#### Success Criteria (Measurable) {#success-criteria}

- Typing a query that occurs N times across the transcript shows a count reading `1 of N`
  where N is the **whole-transcript** total (verify against a hand-counted fixture,
  including matches in rows scrolled off-screen), and every mounted match is highlighted.
  (#s01-model, #p02-count-vs-paint)
- Next/Previous (button, ⌘G/⇧⌘G, Return/Shift-Return) advance the active match with
  wrap-around; the active match scrolls into view clear of sticky headers and flashes.
  (#s03-navigation, #s04-flash)
- Scrolling so a previously-unmounted matching row mounts paints its matches without
  changing the count. (#r01-repaint)
- Toggling Case/Word/Grep changes the match set live and persists across a card reload.
  (#s05-options)
- Expanding a collapsed tool block adds its matches to the count and paint; collapsing
  removes them. (#s06-scope)
- `bunx vite build` succeeds and `just app-test` passes. (#exit-criteria)

#### Scope {#scope}

1. `⌕` Find route + `⇧⌘F` entry chord + placeholder.
2. `DevFindSession` store (query, options, matches, active index, wrap).
3. A store→text index over all transcript rows, reusing the markdown parser, expansion-gated.
4. Whole-transcript search (plain/case/word/grep) producing an ordered match set + count.
5. Custom-Highlight paint of all mounted matches + the active match, repainted on windowing.
6. Navigation (Next/Prev/⌘G/Return) with wrap, scroll-into-view, and a landing flash.
7. Z4B Find cluster: `TugOptionGroup` (Case/Word/Grep) + count chip; option persistence.
8. Wrap-around overlay graphic.
9. Expanded tool-block / embedded-editor (`tug-code-view`) content in scope, plus an
   expansion-change notification.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Searching collapsed tool-block content.
- Find-and-replace.
- Searching non-transcript surfaces.
- Changing the existing CM6-editor `⌘F` (its leaf-first ownership is preserved).
- Multiline-regex matches spanning row boundaries.

#### Dependencies / Prerequisites {#dependencies}

- Route system in `tug-prompt-entry.tsx` (`ROUTE_ITEMS`, `RETURN_ACTION_BY_ROUTE`,
  `routeAwareSubmitButtonMode`, the `SELECT_VALUE`/`SELECT_ROUTE`/`SUBMIT` handlers,
  `performSubmit`) and `RouteLifecycle`.
- `DevTranscriptDataSource` (`@/lib/dev-transcript-data-source`) — row descriptors +
  `numberOfItems`/`rowAt`; `CodeSessionStore` snapshot message types (`@/lib/code-session-store/types`).
- `ensureParsed` (`@/lib/markdown/parse-cache`) — the render-once parse cache the index
  reads through; on miss it calls `parseMarkdownToSanitizedBlocks` (synchronous; needs WASM
  `initSync` in tests). `SanitizedMarkdownBlock.html` is post-DOMPurify HTML.
- CSS Custom Highlight prior art: `selection-guard.ts` (`CSS.highlights.set`) + type shim
  `types/highlight-api.d.ts`.
- `DevTranscriptHost` (`cards/dev-card-transcript.tsx`) — owns the data source, the
  `ToolBlockExpansionState` (`cards/blocks/expansion-state.ts`), and `scrollToIndex`;
  `TugListView` (`OVERSCAN_COUNT = 3`, internal `onScroll` re-window + per-cell `ResizeObserver`).
- `TugOptionGroup`, `TugPushButton`, `TugStableOverlay`, `CanvasOverlayRoot`.
- tugbank defaults for option persistence (template: `@/lib/default-model-store` /
  `@/lib/response-settings-store`) — no `localStorage`.
- `tug-code-view` CM6 search (`setSearchQuery`/`findNext`) for Step 5.

#### Constraints {#constraints}

- Warnings are errors; `bunx tsc` + lint clean; `bunx vite build` must pass (the debug
  app loads the rollup bundle).
- Tuglaws: [L02] stores via `useSyncExternalStore`; [L03] registrations in
  `useLayoutEffect`; [L06] appearance via CSS/DOM not React state; [L26] one Z5 node
  across routes; [D97] Z4A/Z4B/Z5 are layout slots.
- No web storage — tugbank defaults only.
- Real, not fake — no mock-store / jsdom render tests; behavior via `just app-test`.

#### Assumptions {#assumptions}

- The prompt-entry editor doc is the live query while in Find (search-on-type).
- Text stripped from `SanitizedMarkdownBlock.html` matches the rendered DOM `textContent`
  closely enough that per-row match **order** (not just count) aligns between the index and
  the DOM. **Step 1 falsifies or confirms this on real content ([Q01]).**
- Matches are non-overlapping, ordered by row then offset.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings; plan-local decisions `[P01]`; global laws cited as `[L02]`
etc.; steps cite anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does store-index text agree with rendered DOM text? (RESOLVE IN STEP 1) {#q01-index-fidelity}

**Question:** Does the index's per-row text agree with the mounted DOM `textContent` not
just in total count but in **per-row match order**? The painter re-finds matches in a row's
DOM `textContent` and maps the active match's *ordinal* to the k-th DOM range, so the k-th
index match in a row must be the k-th DOM match in that row (across bold/code/links/
headings/lists/tables, and a row that concatenates user/assistant/thinking/tool text).

**Why it matters:** A count-only agreement can still flash the *wrong* occurrence: if the
index concatenates a row's segments in a different order than the DOM lays them out, the
count matches but navigation lands off. Order alignment — not just totals — is the real
invariant.

**Plan to resolve:** The **first task of Step 1**, on the running app against a real
transcript: build the index, paint the DOM, and assert **for each row the index's match
offsets align in order with the DOM's** (not merely equal totals) on a fixture spanning the
common markdown constructs and a mixed-segment row. Because faithful HTML→text needs entity
decoding (a DOM concern), this is an **app-test**, not a pure unit test. If they drift,
adjust the shared-parser extraction (whitespace normalize, verbatim code fences, matching
segment order to DOM order) until they align — **before** any further step builds on the loop.

**Resolution:** OPEN until Step 1's checkpoint; Step 1 does not pass until per-row order
aligns on the fixture.

#### [Q02] Shift-Return → Find Previous (RESOLVE IN STEP 3) {#q02-shift-return}

**Question:** Return maps cleanly to Find Next via the `performSubmit` branch. Can
Shift-Return (the substrate's "newline") be intercepted for Find Previous without invasive
editing?

**Plan to resolve:** In Step 3, read the substrate's return handling; wire if clean, else
defer — Previous is fully covered by the button + ⇧⌘G regardless.

**Resolution:** DECIDED default — Return→Next required; Shift-Return→Previous best-effort.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Store-index text ≠ rendered text → phantom/misordered match | high | med | Retired in Step 1 ([Q01]); per-row order-alignment gate | count exceeds painted matches, or nav flashes the wrong hit |
| Virtualized repaint misses newly-mounted matches | med | high | Repaint on `TugListView`'s window change; `#r01-repaint` | a scrolled-in match doesn't paint |
| Grep regex invalid/pathological | low | med | try/catch → 0 matches; per-row bounded; cap + log | UI stalls on a pattern |
| Sticky-header reveal strands the active match | med | med | Reuse `file-block` sticky-clear reveal | flashed match under pinned header |

**Risk R01: Virtualized repaint** {#r01-repaint}

- **Risk:** `TugListView` mounts only ~`OVERSCAN_COUNT`(3) rows beyond the viewport; matches
  in rows that mount later during a scroll won't paint if painted once.
- **Mitigation:** Repaint highlight Ranges on the list's window change. `TugListView` exposes
  no public window-change signal but already runs an internal `onScroll` re-window +
  per-cell `ResizeObserver` (rAF-coalesced) — hook that; add a public
  `onRenderedRangeChange` only if it isn't reachable. Count stays authoritative from the
  store index, independent of what's mounted.
- **Residual:** A match in a never-mounted row is counted but painted only once navigated to
  (navigation scrolls it in, which mounts + paints it) — acceptable.

**Risk R02: Expansion has no notify surface** {#r02-expansion-notify}

- **Risk:** `ToolBlockExpansionState` is a pure class with no listeners (confirmed); toggling
  a block's expansion notifies nobody, so Spec S06 recompute can't fire.
- **Mitigation:** Add a minimal version counter + listener set to `ToolBlockExpansionState`
  (bump on `set`); the recompute subscribes. Small, contained, in Step 5.
- **Residual:** None once added.

---

### Design Decisions {#design-decisions}

#### [P01] Reuse existing text + highlight machinery (DECIDED) {#p01-reuse}

**Decision:** The store→text index reuses the shared parse **cache** `ensureParsed`
(`@/lib/markdown/parse-cache`) — never the raw `parseMarkdownToSanitizedBlocks`; painting
reuses the CSS Custom Highlight mechanism from `selection-guard.ts`; embedded-editor find
reuses `tug-code-view`'s CM6 search. No bespoke markdown reducer, no bespoke highlight layer.

**Rationale:**
- The prior plan's hand-rolled `markdownToPlainText` duplicated the real parser and would
  drift from rendered text. Using the same parser the renderer uses is how count and paint
  stay in agreement.
- The renderer already parses each finalized row **once** and caches it (`parse-cache.ts`,
  keyed `turn.${turnKey}.message.${messageKey}.${channel}`, text-validated). Going through
  `ensureParsed` means the index free-rides on warm cache entries (Map hits), so a
  whole-transcript index is cheap; calling the raw parser instead re-runs the WASM
  lex/sanitize per row per build and stalls a large transcript.
- `selection-guard.ts` already paints arbitrary DOM Ranges via `CSS.highlights.set` across
  the card — the exact mechanism a transcript-wide highlight needs.

**Implications:** New code is thin glue over existing subsystems, not new subsystems.

#### [P02] Count from the store index; paint from the DOM (DECIDED) {#p02-count-vs-paint}

**Decision:** A store→text index over **all** rows is the authoritative match set + "N of M"
count and navigation order; Custom-Highlight painting resolves DOM Ranges only for mounted
rows and repaints on windowing.

**Rationale:** `OVERSCAN_COUNT = 3` — the DOM holds a tiny window, so a global count must
come from the store; paint can only touch mounted DOM. They are decoupled by necessity.

**Implications:** Need `#r01-repaint`; navigation scrolls a match into view (mounting it)
before the painter can flash it; [Q01] fidelity must hold.

#### [P03] Risk-first: Step 1 is a working end-to-end find (DECIDED) {#p03-risk-first}

**Decision:** Step 1 delivers the whole loop — index, search, count, paint, navigate — on
the real `⌕` route, and is not "done" until it works on real content ([Q01]). Options,
wrap, flash polish, and expanded-editor scope come after.

**Rationale:** The prior plan front-loaded scaffolding and buried the crux; "partial" meant
"nothing works." Proving the crux first means every later step hardens something real.

**Implications:** Step 1 is larger than a typical step — deliberately. Its checkpoint is
falsifiable behavior in the running app, not a green unit test over scaffolding.

#### [P04] `DevFindSession` store + query mirrored from the editor (DECIDED) {#p04-session}

**Decision:** A per-card `DevFindSession` ([L02] store) holds query, options, matches,
activeIndex, wrapped. While in Find the editor doc mirrors into `setQuery` via an editor
`updateListener` (direct store write, no per-keystroke React state — [L22]); leaving Find
clears it (`RouteLifecycle` will-change observer, [L03]).

#### [P05] Z5 = Next; Previous secondary; Return via `performSubmit` (DECIDED) {#p05-z5}

**Decision:** In Find, Z5 poses as **Next**; a route-gated **Previous** secondary button
(reusing the queue-button slot) dispatches `FIND_PREVIOUS`. Return maps to Find Next by
branching **`performSubmit`** (not the `SUBMIT` handler — Return reaches `performSubmit`
directly), so button and Return are unified.

#### [P06] Options are multi-toggle + tugbank-persisted (DECIDED) {#p06-options}

**Decision:** Case/Word/Grep are a `TugOptionGroup` (`value: string[]`, `setValue`);
persisted via tugbank defaults (template `@/lib/default-model-store`), never `localStorage`.
Grep = regex; Word wraps `\b…\b`; Case toggles the flag; all compose.

#### [P07] ⇧⌘F is the entry gesture; ⌘F left editor-owned (DECIDED) {#p07-shortcut}

**Decision:** Find is entered by **⇧⌘F**, a `SELECT_ROUTE "⌕"` chord in the ⇧⌘C/S/B family
dispatched to the prompt-entry responder. Plain `⌘F` is untouched. This sidesteps any
leaf-first contention with the CM6 editors' own `⌘F`. Smart-`⌘F` is a follow-on.

---

### Specification {#specification}

**Spec S01: Match model** {#s01-model}

- `FindOptions = { caseSensitive; wholeWord; grep }`. Empty/invalid query → 0 matches.
- Plain = literal substring (escaped); Grep = `RegExp` source; Word wraps `\b(?:…)\b`; Case
  toggles `i`. Matches non-overlapping, ordered by row then offset. Invalid grep → 0 (no throw).
- Searchable rows: `user`, `assistant` (text + thinking + system notes + expanded tool I/O),
  `shell` (command + output). Collapsed tool bodies and `ghost` rows excluded.

**Spec S02: Store→text index (query-independent) + search (query-dependent)** {#s02-index}

Two distinct pieces — **the index does NOT depend on the query**, only the search does.
Conflating them (rebuilding text on every keystroke) is a perf trap and is banned here.

- **Index (row → text), a function of transcript snapshot + expansion only.** For each
  data-source row index `i` (`0..numberOfItems()`), produce a plain-text string: user
  `.text`; assistant run = per message — `assistant_text.text` reduced to rendered text via
  the **shared parse cache** `ensureParsed(scope, identity, text)`
  (`@/lib/markdown/parse-cache`), text stripped from each block's `html` (`type: "code"`
  fences read verbatim to avoid entity/HTML noise); `assistant_thinking.text`;
  `system_note.text`; `tool_use` input/result serialized **only when expanded**
  (`ToolBlockExpansionState.resolve` + `collapseDefaultFor`); shell `.command` +
  ANSI-stripped `.output`. **Use `ensureParsed`, never `parseMarkdownToSanitizedBlocks`
  directly** — the renderer already warmed a per-row cache keyed by
  `turn.${turnKey}.message.${messageKey}.${channel}` (reconstructable from the row
  descriptor's `turnKey` + each message's `messageKey`); calling the raw parser re-runs the
  WASM lex/sanitize for every row on every build and stalls a large transcript ([P01]).
- The index is keyed to the **data-source row index** so a match's `row` is a valid
  `scrollToIndex` target. Rebuilt on **transcript snapshot / expansion change only**, and
  memoized incrementally (re-extract a row's text only when its source text changed) so a
  900-row transcript costs cache hits, not re-parses.
- **Search (index × query × options)** runs `transcript-search.search` over the finished
  index; re-run **debounced on query / options change** — never rebuilding the index.

**Spec S03: Navigation + count** {#s03-navigation}

- Count chip: `‹active+1› of ‹total›` (whole-transcript), `No results`, or empty; width-
  stabilized (`TugStableOverlay`), no click. Next/Prev step activeIndex modulo total (wrap);
  each advance scrolls the active row in (sticky-clear) and flashes it.

**Spec S04: Highlight + flash** {#s04-flash}

- Two registered highlights: `transcript-find-match` (all mounted matches) and
  `transcript-find-active` (the active one). Repaint on window change. Landing flash reuses
  the reveal-flash box-shadow-ring aesthetic; honors `prefers-reduced-motion`.
- `CSS.highlights` is a **document-global** registry, so with two Dev cards open the
  highlighter must paint only the focused card's find (scope its Ranges to the active card's
  transcript root, as `selection-guard` distinguishes the focused card) — not both cards
  under one shared highlight name.

**Spec S05: Options + persistence** {#s05-options}

- `TugOptionGroup` items case/word/grep; `setValue` → session; persisted to tugbank
  `/api/defaults/find/options`.

**Spec S06: Expansion-gated scope + wrap** {#s06-scope}

- A tool block contributes iff expanded; toggling recomputes (via the new
  `ToolBlockExpansionState` notify, `#r02-expansion-notify`). Wrap fires only on end-crossing;
  a transient graphic mounts in `CanvasOverlayRoot` (WAAPI, non-interactive).

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Active route (incl. `⌕`) | structure/local-data | `RouteLifecycle` + `useRoute` | [L02] |
| Session arm/clear on route change | structure | `RouteLifecycle` observer in `useLayoutEffect` | [L03] |
| Query text | local-data | editor `updateListener` → `DevFindSession.setQuery` (store write) | [L02], [L22] |
| Options | local-data | `DevFindSession` + `TugOptionGroup` `setValue` + tugbank persist | [L02] |
| Match set / active index / wrapped | local-data | `DevFindSession` + `useSyncExternalStore` | [L02] |
| All-match + active paint | appearance | CSS Custom Highlight, imperative DOM | [L06] |
| Landing flash / wrap graphic | appearance | CSS keyframe / WAAPI, not React state | [L06] |
| Tool-block expansion (+ new notify) | local-data | `ToolBlockExpansionState` + version/listener | [L24] |
| Z5 Next / Previous | structure | one Z5 node + route-gated secondary | [L26], [D97] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `@/lib/dev-find-session.ts` | `DevFindSession` store + `FindOptions`/`FindMatch` types |
| `@/lib/transcript-search.ts` | Pure match engine (plain/case/word/grep) |
| `@/lib/transcript-search-index.ts` | Store→text index over all rows ([P02], Spec S02) — reads through `ensureParsed` (parse cache), memoized incrementally |
| `@/components/tugways/transcript-find-highlighter.ts` | Custom-Highlight painter + flash ([P02], Spec S04) |
| `@/components/tugways/chrome/dev-find-cluster.tsx` | Z4B cluster: `TugOptionGroup` + count chip |
| `@/components/tugways/chrome/find-wrap-overlay.tsx` | Wrap graphic in `CanvasOverlayRoot` |
| `transcript-find.css` | `::highlight(transcript-find-*)` + flash keyframe |

#### Symbols to modify {#symbols}

| Symbol | Location | Notes |
|--------|----------|-------|
| `ROUTE_ITEMS`, `RETURN_ACTION_BY_ROUTE`, `ROUTE_FIND` | `tug-prompt-entry.tsx` | add `⌕` |
| `performSubmit`, `routeAwareSubmitButtonMode`, Previous button | `tug-prompt-entry.tsx` | Find branches ([P05]) |
| `findSession` prop + query mirror + clear observer | `tug-prompt-entry.tsx` | [P04] |
| ⇧⌘F chord | `keybinding-map.ts` | `SELECT_ROUTE "⌕"` ([P07]) |
| `routeChipKeys`/`RouteChipKey`/`find` slot | `chrome/dev-route-chrome-manifest.tsx` | Find cluster |
| `DEV_PROMPT_PLACEHOLDER_BY_ROUTE`, session construction, wiring | `cards/dev-card.tsx` | |
| `ToolBlockExpansionState` version + listeners | `cards/blocks/expansion-state.ts` | `#r02-expansion-notify` |
| repaint-on-window hook | `tug-list-view.tsx` | `#r01-repaint` |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose |
|----------|---------|
| Unit | `transcript-search` semantics (plain/case/word/grep, ordering, invalid regex); `DevFindSession` nav/wrap |
| Unit | Index projection for the **DOM-free** row kinds (user `.text`, thinking, shell command/ANSI-stripped output) |
| App-test | `[Q01]` fidelity gate: index per-row match **order** aligns with DOM `textContent` on a markdown + mixed-segment fixture; and the full flow (⇧⌘F → type → global count + paint, Next/Prev/wrap/flash, expansion gating) |
| Build | `bunx vite build` |

**Note on the markdown-render fidelity test:** it is deliberately an **app-test**, not a
`bun:test`. Faithful HTML→text needs entity decoding (a DOM concern) and the parser needs
WASM `initSync`; a pure "index vs fixture" unit test over markdown would require a DOM shim,
which bumps the no-jsdom rule. Pure unit tests cover the search engine and the DOM-free row
projections only.

**Out of tests:** no mock-store / jsdom render tests (search logic on real strings; markdown
fidelity + behavior via `just app-test`); no pixel-diffing the flash (assert range/attribute
state — WebKit paints a spurious wash for a collapsed-Range highlight).

---

### Execution Steps {#execution-steps}

> Risk-first. Step 1 is a working find that retires the crux; later steps harden it. Commit
> after each checkpoint on the dash worktree.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Working find on the ⌕ route: index → search → count → paint → Return-navigate | done | 0bbc3056f |
| #step-2 | Virtualized repaint + landing flash + sticky-clear reveal | done | 5c0a9acf1 |
| #step-3 | Z5 Next/Prev + ⌘G + wrap + wrap graphic | done | 436bb2241 |
| #step-4 | Z4B cluster: options + count chip + persistence | done | f1bcd8427 |
| #step-5 | Expanded tool/editor scope + expansion notify | pending | — |
| #step-6 | Integration + app-test | pending | — |

#### Step 1: Working find on the ⌕ route — index → search → count → paint → Return-navigate {#step-1}

**Commit:** `dev-find(core): ⌕ route + whole-transcript index + search + Custom-Highlight paint`

**References:** [P01] Reuse, [P02] Count-vs-paint, [P03] Risk-first, [P04] Session, [P05] Z5 (performSubmit branch), [P07] Shortcut, [Q01] Index fidelity, Spec S01/S02/S03/S04, Risk R01, (#context, #p02-count-vs-paint)

> Deliberately the largest step: it is the whole loop, **driven by real typing in the real
> route** (route wiring folded in so [Q01] is tested by a real query, not a dev hook). It is
> not "done" until per-row order aligns ([Q01]) on real content. Everything after hardens it.

**Artifacts:** `dev-find-session.ts`, `transcript-search.ts`, `transcript-search-index.ts`,
`transcript-find-highlighter.ts`, `transcript-find.css`; `⌕` route + `⇧⌘F` wiring in
`tug-prompt-entry.tsx` / `keybinding-map.ts` / `dev-card.tsx`; index + painter wiring in
`DevTranscriptHost`.

**Tasks:**
- [ ] **Route + query source (real typing):** add `⌕` to `ROUTE_ITEMS` / `RETURN_ACTION_BY_ROUTE` / `ROUTE_FIND` + placeholder; `⇧⌘F` `SELECT_ROUTE "⌕"` chord (plain `⌘F` untouched); `findSession` prop + `dev-card` constructs one per body; editor `updateListener` mirrors doc→`setQuery` while in Find; `RouteLifecycle` will-change clears on leave ([P04], [P07]).
- [ ] **Index (query-independent, via the cache):** build `transcript-search-index` through `ensureParsed` (`@/lib/markdown/parse-cache`, reconstructing the `turn.${turnKey}.message.${messageKey}.${channel}` identity so it hits warm entries — **never the raw parser**), rebuilt on snapshot/expansion only, memoized incrementally ([P01], [P02], Spec S02).
- [ ] **[Q01] fidelity gate (app-test, order not just count):** on the running app against a real transcript, assert **for each row the index's match offsets align in order with the mounted DOM `textContent`** on a fixture spanning bold/italic/code/links/headings/lists/tables and a mixed-segment row. Adjust extraction (whitespace normalize, verbatim `type:"code"` fences, segment order = DOM order) until aligned. **Do not proceed until aligned.**
- [ ] Pure `transcript-search` (Spec S01) + `DevFindSession`; **search re-runs debounced on query/options only**, never rebuilding the index.
- [ ] `transcript-find-highlighter`: register `transcript-find-match`/`-active` **scoped to the focused card's transcript root** ([L06], Spec S04 multi-card note), resolve DOM Ranges for mounted rows (reuse the `selection-guard` approach), paint, flash the active, repaint on the list's window change (Risk R01).
- [ ] Whole-transcript count from the index; `performSubmit` Find branch → `FIND_NEXT` so Return advances → `scrollToIndex` → paint + flash ([P05], minimal — full Z5 buttons/⌘G/wrap are Step 3).

**Tests:**
- [ ] Unit (`bun:test`, no DOM): `transcript-search` semantics + invalid-regex; `DevFindSession` nav/wrap; index projection for DOM-free rows (user/thinking/shell).
- [ ] App-test: `[Q01]` per-row order alignment on the fixture; type a real query → whole-transcript count, matches paint, Return jumps + scrolls + flashes (incl. a match that starts off-screen).

**Checkpoint:**
- [ ] `bunx tsc --noEmit` + unit tests green; `bunx vite build`.
- [ ] **Live: `⇧⌘F` → type in a real transcript → count shows the whole-transcript N, every mounted match highlights, Return jumps + scrolls + flashes; `[Q01]` per-row order aligns on the fixture.**

---

#### Step 2: Virtualized repaint + landing flash + sticky-clear reveal {#step-2}

**Depends on:** #step-1

**Commit:** `dev-find(paint): correct repaint across windowing + sticky-clear reveal`

**References:** Risk R01, Risk R03(sticky), Spec S04, (#r01-repaint)

**Tasks:**
- [ ] Harden repaint: scrolling mounts new rows → their matches paint; unmounted rows drop cleanly; count unchanged.
- [ ] Reveal scroll clears summed sticky chrome (`--tugx-pin-stack-top` + block/file headers) per `file-block.tsx`'s approach so the flashed match is fully visible.

**Checkpoint:**
- [ ] `bunx vite build`; live: scroll through a transcript with many matches — all paint as they mount; flashed match never stranded under a pinned header.

---

#### Step 3: Z5 Next/Prev + ⌘G + wrap + wrap graphic {#step-3}

**Depends on:** #step-1

**Commit:** `dev-find(nav): Z5 Next + Previous, ⌘G/⇧⌘G, wrap-around graphic`

**References:** [P05] Z5, [Q02] Shift-Return, Spec S03/S06, (#p05-z5)

**Tasks:**
- [ ] `routeAwareSubmitButtonMode` Next pose for Z5; route-gated Previous secondary → `FIND_PREVIOUS`; `⌘G`/`⇧⌘G` → `FIND_NEXT`/`FIND_PREVIOUS`; Shift-Return→Previous best-effort ([Q02]). (Return→`FIND_NEXT` via `performSubmit` already landed in Step 1.)
- [ ] Wrap graphic in `CanvasOverlayRoot` (WAAPI) on end-crossing only.

**Checkpoint:**
- [ ] `bunx vite build`; live: all nav paths cycle with wrap; wrap graphic on crossing only.

---

#### Step 4: Z4B cluster — options + count chip + persistence {#step-4}

**Depends on:** #step-1

**Commit:** `dev-find(chrome): Case/Word/Grep toggles + match-count chip`

**References:** [P06] Options, Spec S05, [L02], [L06], [L11]

**Tasks:**
- [ ] `dev-find-cluster.tsx` (`TugOptionGroup` + count chip via `TugStableOverlay`); `routeChipKeys` `find` branch; wire `setValue`→session; persist via tugbank (template `default-model-store`). Cluster refuses focus-steal ([L11]).

**Checkpoint:**
- [ ] `bunx vite build`; live: toggles change the match set; count reads `N of M`; toggles survive a card reload.

---

#### Step 5: Expanded tool/editor scope + expansion notify {#step-5}

**Depends on:** #step-1

**Commit:** `dev-find(scope): expanded tool bodies + embedded editors + expansion recompute`

**References:** Spec S06, Risk R02, [P02], (#r02-expansion-notify)

**Tasks:**
- [ ] Add version + listeners to `ToolBlockExpansionState`; the index recompute subscribes (Risk R02).
- [ ] Index includes expanded tool I/O (via the same `ensureParsed`/verbatim path); painter resolves Ranges inside expanded `tug-code-view` `contentDOM` (fully laid out when mounted). Collapsed contribute nothing.

**Checkpoint:**
- [ ] `bunx vite build`; live: expanding a block adds its matches (count + paint); collapsing removes them; a match inside an expanded file body flashes.

---

#### Step 6: Integration + app-test {#step-6}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] End-to-end: ⇧⌘F → type → global count + paint → Next/Prev/⌘G/⇧⌘G/Return → wrap graphic → options (persisted) → expanded-block match → exit clears.

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test` passes.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A ⇧⌘F Find route that searches the whole transcript live, shows a global
"N of M", paints all mounted matches with an active-match flash, navigates with wrap, and
persists its toggles.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Step 1's fidelity gate held: per-row match order (not just count) aligns index↔DOM on the fixture ([Q01]).
- [ ] ⇧⌘F enters Find; plain ⌘F untouched ([P07]).
- [ ] Global "N of M"; all mounted matches painted; active flashes on each step.
- [ ] Nav (button/⌘G/⇧⌘G/Return) wraps with the wrap graphic.
- [ ] Options change the set live and persist; expanded-block matches counted, collapsed not.
- [ ] `bunx vite build` + `just app-test` pass.

#### Roadmap / Follow-ons {#roadmap}

- [ ] Smart `⌘F` (enter Find when no CM6 editor owns find).
- [ ] Find-and-replace.
