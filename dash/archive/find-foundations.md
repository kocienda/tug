<!-- devise-skeleton v4 -->

## Find Foundations — Correct Transcript Find, One-Shot Commands, Text-Card Find {#find-foundations}

**Purpose:** Finish the Dev card's transcript Find on a correct, tested foundation
(scoped painting, shell + tool-body + file-body content, expansion notify), remove the
first-character route-switching sigils, add one-shot `/shell` and `/find` slash commands
to the Code route, and bring a bottom-docked, full-parity Find bar to Text cards — all
sharing one find UI vocabulary over two engines.

> **Supersedes** `dash/find-route.md`. That plan's Steps 1–4 landed on `main` in
> commit `3bf91cbd` ("tugdash(find-route): Find route: live transcript search in the Dev
> card"); its Steps 5–6 are replaced by this plan. This plan was written after (a) a
> code audit of the landed work, (b) the discovery that old-Step-5's premise is false
> (tool bodies are a mix of renderers, and `tug-code-view` virtualizes — see
> #why-dom-walk-fails), and (c) three architecture investigations (sigil system, text
> card, slash-command pipeline) whose findings are baked into #landed-inventory and the
> Deep Dives.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Find route (`⌕`) shipped its core loop: a whole-transcript store→text index counts
matches over prose rows, a CSS Custom Highlight painter paints the mounted ones, and
Z5/⌘G/Return navigate with wrap, flash, and persisted Case/Word/Grep toggles. But the
audit of `3bf91cbd` found the verification spine was never built (no fidelity app-test,
no index-projection unit tests), a live count↔paint bug (the painter re-searches a
matching row's **entire** DOM — including tool-block chrome text the index never counts,
so extra highlights paint and the active ordinal can land on the wrong occurrence),
and scope debt (shell rows and all tool-body content project as `""`). Meanwhile two
adjacent problems surfaced: typing `$` as the first character of a Find query switches
the route to Shell (the first-character sigil feature composes badly with a route whose
draft is a search query), and the Text card grew an undesigned find strip at the top of
its editor that should instead match the Dev card's bottom-entry look.

This plan fixes the foundation before extending it: subtraction first (sigils), then
correctness (scoped painting + the missing tests), then scope (shell, expanded tool
results, file bodies via CM6), then the new surfaces (one-shot `/shell` and `/find`
from the Code route; the Text card's bottom-docked Find bar with full cluster parity).

#### Strategy {#strategy}

- **Two engines, one find language ([P01]).** Transcript find counts from a store index
  and paints mounted DOM (the only mechanism that works over a virtualized row list).
  Document find (Text card, embedded file bodies) delegates to CM6's own
  `@codemirror/search` (the only mechanism that works over a virtualizing editor). Both
  drive the same UI vocabulary — Case/Word/Grep cluster, width-stabilized "N of M"
  chip, prev/next, landing flash — via a small shared `FindSurface` interface.
- **Subtraction first.** Remove the sigil feature (and its submit-time strip) before
  anything else; it is user-facing breakage today.
- **Correctness before scope.** Make painting opt-in-scoped and symmetric with the
  index, and encode the fidelity gate as a durable app-test, before adding shell/tool
  content to the searchable set.
- **Expansion gating with honest paint.** Collapsed blocks contribute nothing ([P04]).
  Folded-but-expanded content (terminal previews, folded file bodies) is counted in
  full; painting covers what is mounted (a fold shows a *prefix*, which preserves
  ordinal alignment — see #fold-prefix-alignment), and navigation unfolds on demand.
- **Verification is part of each step ([P11]).** Every scope extension lands with its
  fixture extension; checkboxes and the Step Status Ledger are maintained as steps land.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `$`, `?`, or `>` at offset 0 of the prompt editor inserts the character and
  never switches the route; all routes remain reachable via the Z4A popup and
  ⇧⌘C/S/B/F. (#step-1)
- With a query matching both a row's prose and its tool-block chrome (e.g. a tool
  name or timing text), the painted highlight count equals the index count for that
  row, and Next lands on true content occurrences only. (#step-2, app-test)
- A per-row order-alignment app-test (the old plan's unfulfilled [Q01] gate) exists
  and passes over a fixture spanning markdown constructs, a mixed-segment row, a shell
  exchange, and an expanded markdown tool result. (#step-3)
- Searching text that appears in a shell command or output produces correct count and
  paint; a match beyond a folded terminal preview is counted, and navigating to it
  unfolds and flashes it. (#step-5, #step-8)
- Expanding a tool block adds its markdown/text-result matches to count and paint;
  collapsing removes them — driven by the new expansion notify, no manual refresh.
  (#step-4, #step-6)
- A match inside an expanded Read file body is counted from store text, painted by
  CM6 search inside the embedded editor, and navigation lands on and flashes the
  exact occurrence — including occurrences on lines outside CM6's rendered viewport.
  (#step-8)
- `/shell <cmd>` submitted on the `❯` route runs one shell exchange into the
  transcript and the route remains `❯`; `/shell` completion is not offered on other
  routes. (#step-9)
- `/find <query>` submitted on the `❯` route paints all matches, jumps to and flashes
  the first, leaves ⌘G/⇧⌘G cycling live, and dissolves on the next submit, on Escape,
  or on entering-and-leaving the ⌕ route — the route never leaves `❯`. (#step-10)
- The Text card's find strip no longer renders at the top; ⌘F opens a bottom-docked
  bar (above the status bar) with Case/Word/Grep toggles, a "N of M" count chip,
  prev/next, and Escape-close; toggles persist and are shared with the Dev card's.
  (#step-12)
- `cd tugdeck && ./node_modules/.bin/tsc --noEmit`, `bun test`,
  `./node_modules/.bin/vite build`, and `just app-test` all pass at phase end.

#### Scope {#scope}

1. Remove first-character route switching (extension, submit-time strip, tests, laws).
2. Opt-in searchable-content markers; painter/index symmetry; projection unit tests.
3. The fidelity app-test gate (durable successor to old-plan [Q01]).
4. `ToolBlockExpansionState` change notification (version + listeners).
5. Shell exchange rows (command + ANSI-stripped output) in scope.
6. Expanded tool-block markdown/text results (and Bash command + terminal output) in scope.
7. Segmented row projection; file bodies (Read) counted from store text, painted and
   navigated via `tug-code-view`'s CM6 search delegate; unfold-on-navigate registry.
8. One-shot `/shell` and `/find` local slash commands, offered on the `❯` route only.
9. Shared `FindSurface` interface + `TugFindCluster` extraction.
10. Text card: remove the top find strip; bottom-docked find bar with full parity.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Searching `JsonTreeBlock` content (tool inputs / structured results) — its visible
  text depends on per-node fold state and is not faithfully reproducible from the store.
- Searching `DiffBlock` content (aria-hidden gutters, marker glyphs; needs its own
  projection design) and `AgentTranscriptBlock` child content (nested tool blocks).
- Searching collapsed tool blocks — collapsed contributes nothing, including the
  visible header command line ([P04] keeps the gate binary and the index simple).
- Find-and-replace; multiline regex spanning row boundaries; smart plain-⌘F in the
  Dev card (⌘F remains editor-owned there).
- Any change to the gallery host.

#### Dependencies / Prerequisites {#dependencies}

- Landed find core from `3bf91cbd` — full inventory in #landed-inventory.
- `just app-test` harness (`tests/app-test/`), including its known constraints
  (#r04-app-test-limits).
- Project-local toolchain: run `./node_modules/.bin/tsc --noEmit` and
  `./node_modules/.bin/vite build` from `tugdeck/` (a bare `bunx tsc`/`bunx vite` can
  fetch wrong global versions); `bun test` runs normally.

#### Constraints {#constraints}

- Warnings are errors; `vite build` must pass (the debug app loads the rollup bundle).
- Tuglaws: [L02] stores via `useSyncExternalStore`; [L03] registrations in
  `useLayoutEffect`; [L06] appearance via CSS/DOM, never React state; [L07] live refs
  for mount-time closures; [L11] control emission; [L26] one node across modes.
- No web storage — tugbank defaults only (`@/settings-api`).
- Real, not fake — no mock-store / jsdom render tests; behavior via `just app-test`.

#### Assumptions {#assumptions}

- `structured_result.file.content` (Read tool) is the clean file bytes CM6 renders —
  verified in `read-tool-block.tsx` (`composeFileData`; the `tool_result.output`
  cat-n payload is agent-facing metadata and is **not** used).
- A folded `TerminalBlock` renders exactly the **first** `collapseThreshold` lines —
  the prefix property #fold-prefix-alignment relies on (verified: `renderTerminal`
  slices from the front; `DEFAULT_COLLAPSE_THRESHOLD = 25`).
- CM6 `SearchQuery` supports `caseSensitive` / `regexp` / `wholeWord` — verified in
  both `tug-code-view.tsx` and `tug-text-card-editor.tsx` delegates.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings; plan-local decisions `[P01]` (never `[D##]` — that
prefix cites the global `tuglaws/design-decisions.md`); steps cite anchors, never line
numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Active-ordinal derivation cost in huge CM6 documents (RESOLVE IN STEP 12) {#q01-cm6-ordinal-cost}

**Question:** The Text card's "N of M" chip needs the active match's ordinal, derived
by iterating `SearchQuery.getCursor()` and comparing against the current selection.
Is that iteration acceptable on very large files (100k+ lines), or does it need a cap?

**Why it matters:** The count chip updates on every query keystroke and every
next/prev; an uncapped full-document cursor walk could stall typing in a huge file.

**Plan to resolve:** Implement `getMatchInfo()` with an iteration cap at
`DEFAULT_MATCH_LIMIT` (5000, from `@/lib/transcript-search`) — the chip reads
`5000+` when capped, mirroring the transcript engine's existing cap. Verify feel on a
large real file during the step's live checkpoint.

**Resolution:** RESOLVED in #step-12 — `getMatchInfo` caps the cursor walk at 5000 (`MATCH_INFO_CAP`, mirroring `DEFAULT_MATCH_LIMIT`) and reports `capped`, which the shared chip renders as `N+`. Verified live via at0223 over a real file.

#### [Q02] Where Escape clears a one-shot `/find` (RESOLVE IN STEP 10) {#q02-one-shot-escape}

**Question:** The prompt editor's Escape already has consumers (completion dismiss;
the empty-doc `onEscapeWhenEmpty` pane collapse). Where does "Escape dissolves the
one-shot find" slot without stealing those?

**Why it matters:** Escape ordering bugs are invisible until a user hits the wrong
one (e.g. Escape collapses the entry pane while find highlights linger).

**Plan to resolve:** In #step-10, extend the existing empty-Escape keymap entry in
`tug-prompt-entry.tsx` (`editorExtensions`, the `keymap.of` Escape binding gated on
`doc.length === 0`): before yielding to `onEscapeWhenEmpty`, if
`findSessionRef.current` holds matches while the route is `❯`, clear the session and
consume the event. A non-empty doc leaves Escape to the completion layers as today.

**Resolution:** RESOLVED in #step-10 — the substrate Escape keymap's single-press empty-editor branch dissolves live one-shot highlights (consuming the press) BEFORE `onEscapeWhenEmpty`'s pane collapse; completion layers keep non-empty Escape. Proven live by at0222.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Segment refactor regresses working prose find | high | med | #step-3's app-test lands **before** the refactor; step 7 is behavior-identical for prose by construction | fidelity test fails post-refactor |
| Two paint paths (Custom Highlight vs CM6 search) drift | med | med | One count source (store index); CM6 paints only inside editor segments; e2e app-test asserts count == painted across both | count ≠ painted highlights in a file-body row |
| Marker scheme misses a prose container → content silently unsearchable | med | med | Projection unit tests + fidelity fixture enumerate every searchable row kind; markers are stamped at named components (#s01-searchable-model) | a visible text run never highlights |
| App-test keyboard/gesture limits | med | high | Known constraints listed in #r04-app-test-limits; assert store state + DOM attributes, not synthetic chords the harness can't deliver | flaky or impossible assertions |
| Index size balloons with file bodies | low | med | Per-segment projection cap (#s02-segment-model); `DEFAULT_MATCH_LIMIT` already bounds matches | keystroke lag while searching |

**Risk R01: Losing count↔paint agreement as scope grows** {#r01-count-paint}

- **Risk:** Every new searchable content kind is a new way for the index's text to
  disagree with the DOM's.
- **Mitigation:** The marker system makes searchability opt-in and symmetric ([P02]) —
  the painter cannot see unmarked text, the index projects only marked kinds; the
  fidelity app-test grows a fixture case per scope step.
- **Residual:** A future body kind that marks its content but projects differently can
  still drift — caught by the fixture only if added there (documented in
  #s01-searchable-model as a checklist obligation).

**Risk R02: CM6 delegate navigation lands on the wrong occurrence** {#r02-cm6-nav}

- **Risk:** Driving `findNext` k times to reach the k-th in-editor occurrence can
  desync if CM6's match enumeration differs from the store projection (regex flavor,
  line endings).
- **Mitigation:** Both sides compile from the same `FindOptions`; the store text IS
  the editor text (`structured_result.file.content` is what `FileBlock` feeds CM6);
  position via one `setSearchQuery` + cursor walk to the k-th match, selecting it
  directly (`selectMatch` semantics) rather than k blind `findNext` calls.
- **Residual:** CM6 regexp dialect differences for exotic grep patterns; acceptable —
  grep is already best-effort (invalid → 0 matches).

**Risk R03: Expansion notify causes index-rebuild storms** {#r03-notify-storm}

- **Risk:** Rebuilding the whole index on every expansion toggle could jank a large
  transcript.
- **Mitigation:** The rebuild already rides a `useMemo` keyed by snapshot identity;
  add the expansion version as one more key. Rebuild cost is parse-cache hits (the
  design premise of `transcript-search-index.ts`); the 100ms search debounce in
  `dev-card-transcript.tsx` already coalesces the downstream search.
- **Residual:** None expected; verify by toggling blocks rapidly in a large transcript.

**Risk R04: App-test harness constraints** {#r04-app-test-limits}

- **Risk:** Some gestures can't be driven headless.
- Known constraints (from the app-test suite's history): a headless sweep cannot make
  an editor the responder-chain **leaf** first responder for a control dispatch (cover
  editor-leaf actions at the store layer); synthetic gestures need settle delays; a
  collapsed Range in a CSS Custom Highlight paints a spurious wash in WebKit (publish
  null for a bare caret — never assert on pixel washes); `app.screenshot()` exists but
  pixel-diffing the flash is banned — assert ranges/attributes/store state instead.

---

### Design Decisions {#design-decisions}

#### [P01] Two find engines, one find language (DECIDED) {#p01-two-engines}

**Decision:** Transcript find keeps the store-index + Custom-Highlight architecture;
document find (Text card, embedded file bodies) uses CM6 `@codemirror/search` via the
existing delegates. Both are fronted by the same UI pieces over a shared `FindSurface`
interface (#s05-find-surface).

**Rationale:**
- The transcript is a virtualized custom list — only a store index can count it, only
  DOM painting can highlight it.
- CM6 virtualizes its own DOM (#why-dom-walk-fails) — only CM6's search, which works
  on the *document*, can count and paint an editor. Both `tug-code-view` and
  `TugTextCardEditor` already carry complete (dormant) search delegates.
- One cluster/chip/nav vocabulary keeps the UX identical across cards and makes the
  next find surface (any future card) a `FindSurface` implementation, not a rebuild.

**Implications:** The cluster component must not know about `DevFindSession`
specifically (#step-11); the transcript engine must treat editor content as segments
it counts but does not DOM-paint (#s02-segment-model).

#### [P02] Searchability is opt-in in the DOM, symmetric with the index (DECIDED) {#p02-opt-in-markers}

**Decision:** The painter walks only subtrees marked `data-tugx-findable`; the index
projects exactly the content kinds that carry the marker. Chrome (headers, badges,
timing, fold cues, notice bands, gutters) is never marked.

**Rationale:**
- The landed painter walks the whole row cell and over-paints chrome text the index
  never counts — the live ordinal bug. A blacklist (exclude `.tugx-katex`, then
  exclude chrome, then exclude the next thing) loses by default; an allowlist wins by
  default: a future body kind is unsearchable until it is deliberately marked *and*
  projected.
- Symmetry is the [Q01]-order invariant's structural guarantee: per row, the index
  concatenates marked kinds in DOM order, the painter walks marked subtrees in DOM
  order.

**Implications:** Prose containers must be stamped (#s01-searchable-model names each);
`isInExcludedSubtree` inverts into an `isInFindableSubtree` walk (`.tugx-katex`
remains excluded *within* findable subtrees); adding a searchable kind is a two-sided
checklist (marker + projection + fixture case).

#### [P03] Segmented row projection (DECIDED) {#p03-segments}

**Decision:** The index projects each row as an ordered list of segments —
`{ kind: "dom" | "editor", key, text }` — instead of one string. `dom` segments are
painted by the Custom-Highlight walk; `editor` segments are counted from store text
and painted/navigated by the owning CM6 delegate. `transcript-search.ts` stays a pure
string engine; the index layer runs it per segment and assembles segment-tagged
matches.

**Rationale:**
- File bodies cannot be DOM-painted (#why-dom-walk-fails) but must be counted; the
  match model needs to know *which mechanism* paints each match.
- Keeping `search()` pure over strings preserves its tests and its reuse by the
  painter's per-subtree re-search.

**Implications:** `FindMatch` gains segment identity (#s02-segment-model);
`DevFindSession` and the count chip are unaffected (they consume the flat ordered
match list); the painter partitions by segment kind.

#### [P04] Expansion-gated scope; navigation unfolds (DECIDED) {#p04-expansion-gated}

**Decision:** A collapsed tool block (or shell exchange) contributes nothing to the
index — including its visible header command. An expanded block contributes its
command and its searchable body content in full, even when an *internal* fold
(terminal 25-line preview, file-body 80-line fold) hides part of it; navigating to a
match hidden by an internal fold unfolds it first.

**Rationale:**
- Binary gating on `ToolBlockExpansionState.resolve` keeps the index a pure function
  of (snapshot, expansion) — internal folds are component React state and must not
  become index inputs.
- Counting folded-but-expanded content in full matches user intent ("find it wherever
  it is"); the fold-prefix property (#fold-prefix-alignment) keeps partial paint
  ordinal-correct, and unfold-on-navigate closes the gap.

**Implications:** Needs the expansion notify (#step-4) and the unfold registry
(#s04-find-target-registry); the collapsed-header command being unsearchable is an
accepted, documented gap (see #non-goals).

#### [P05] File bodies: count from store, paint and navigate via CM6 search (DECIDED) {#p05-file-bodies-cm6}

**Decision:** An expanded Read block's file text (`structured_result.file.content`)
is an `editor` segment: counted by the store engine, painted by driving the embedded
`tug-code-view`'s dormant search delegate with the same query/options, navigated by
selecting the k-th CM6 match (reveal + CM6's selected-match styling as the active
treatment).

**Rationale:** CM6 search operates on the document, so off-viewport matches paint and
reveal correctly — the one mechanism virtualization cannot defeat. The delegate
(`setSearchQuery`/`findNext`/`findPrevious`/`getMatchCount`, hidden panel,
`.cm-searchMatch` theming) already exists in `tug-code-view.tsx`, self-described as
"latent capability for a future Find redesign".

**Implications:** The transcript highlighter must skip `editor` segments in its DOM
walk; painting an editor segment requires its block to be mounted (windowed rows
paint on mount, exactly like dom segments); clearing find must clear every touched
editor's query (`clearSearch`).

#### [P06] One-shot local commands are Code-route-only, declared in the registry (DECIDED) {#p06-one-shot-registry}

**Decision:** `LocalSlashCommandSpec` gains `codeRouteOnly?: boolean`. `/shell`,
`/find`, and the existing `/btw` set it. The completion layer withholds such commands
when the current route is not `❯`, and `performSubmit`'s local-command split skips
them off-`❯` (falling through to the route's native handling).

**Rationale:** The user's contract: one-shot commands are accelerators *from* the
Code route; on `$` a literal `/shell ls` should reach the shell as typed, not be
re-intercepted. Declaring the gate in the registry keeps offering and handling in one
place (the registry is already the single source the completion provider and matcher
share).

**Implications:** The completion filter needs the live route — it is applied inside
`tug-prompt-entry.tsx` (which owns `RouteLifecycle`), not in `use-dev-card-services.ts`
(which composes providers route-blind); `/btw` stops being interceptable from `$`
(behavior change, intended).

#### [P07] `/find <query>` = one-shot session, route stays `❯` (DECIDED) {#p07-one-shot-find}

**Decision:** `/find foo` runs the transcript search (`findSession.setQuery("foo")` +
`next()`): all matches paint, the first flashes, ⌘G/⇧⌘G cycle — while the route
remains `❯`. No count chip, no toggles (those belong to the ⌕ route). The one-shot
state dissolves on the next submit, on Escape ([Q02]), or on ⌕-route entry/leave
(whose mirror/clear observers already own the query there).

**Rationale:** Matches the user's stated intent verbatim ("keeps the Code route, but
adds in the find niceties"). Reusing `DevFindSession` unmodified means the painter,
wrap overlay, and nav pipeline all work with zero new state.

**Implications:** The `FIND_NEXT`/`FIND_PREVIOUS` handlers in `tug-prompt-entry.tsx`
must drop their `route === ROUTE_FIND` gate in favor of "session has matches";
`performSubmit` must clear a lingering one-shot session before dispatching a normal
submission (so stale highlights never outlive a new turn).

#### [P08] Remove the sigil extension AND the submit-time strip together (DECIDED) {#p08-remove-sigils}

**Decision:** Delete `route-prefix-extension.ts` and its install; delete the
submit-time strip (`stripLeadingRoutePrefix` / `computeSubmitText`'s strip behavior
and the atom-offset adjustment) and `ROUTE_PREFIX_ALIAS`.

**Rationale:** Once typing `$` at offset 0 no longer switches routes, a leading `$`
in a draft is intentional text — stripping it at submit would corrupt the message.
The two features are only coherent as a pair. (Investigation confirmed nothing else
depends on either: route persistence, history recall, and the shell Share gesture all
call `setRoute` directly and store stripped text.)

**Implications:** `computeSideQuestionArg`'s leading-`?` strip also retires; at0085's
prefix-trigger scenario is removed; `tuglaws/route-lifecycle.md`'s trigger table and
[D110]'s prefix-alias clause are updated.

#### [P09] Text card find: bottom-docked bar, full parity, top strip removed (DECIDED) {#p09-text-card-bar}

**Decision:** Remove the current `.text-card-find-bar` top strip. Add a bottom-docked
find bar (between the editor and `TextCardStatusBar`) that replicates the Dev card
Find route's UI/UX: query field, shared Case/Word/Grep cluster, "N of M" chip,
prev/next buttons, ⌘F summon, Escape dismiss, match flash via CM6.

**Rationale:** The top strip was never designed; the Dev card's bottom-entry
composition is the house look for card-level input. Full parity via the shared
cluster is the point of [P01].

**Implications:** `TugTextCardEditorDelegate` grows `getMatchInfo()` (count + active
ordinal, [Q01]); options flow through the same `FindOptions` shape into CM6
`SearchQuery`; the bar is find-only (no Z4A route trigger, no submit lifecycle).

#### [P10] One global find-options preference (DECIDED) {#p10-global-options}

**Decision:** Case/Word/Grep persist once, globally, at the existing tugbank slot
`dev.tugtool.find` / `options` (`readFindOptions`/`putFindOptions` in
`@/settings-api`) — shared by the Dev transcript find and the Text card find.

**Rationale:** Case-sensitivity is a user disposition, not a per-card setting; one
key means the toggles feel like one feature across surfaces.

**Implications:** The Text card seeds from `readFindOptions` and writes through
`putFindOptions`, exactly as `dev-find-cluster.tsx` does today.

#### [P11] The verification spine is part of the work (DECIDED) {#p11-verification-spine}

**Decision:** The fidelity app-test lands *before* scope extensions (#step-3), grows a
fixture case with each scope step, and the Step Status Ledger + task checkboxes are
updated as each step lands.

**Rationale:** The audit of `find-route.md` found its central gate was never encoded
and its checkboxes never touched — which is how every step produced "unforeseen"
gotchas. Falsifiable gates, maintained in the document, are the fix.

**Implications:** Steps that extend scope name their fixture additions explicitly; a
step is not done until its ledger row says so.

---

### Deep Dives {#deep-dives}

#### Landed inventory — what exists on `main` to build upon {#landed-inventory}

All paths under `tugdeck/src/` unless noted. This is the complete find surface as of
commit `3bf91cbd` + the Shift+Return untangle (`f05c95873`-era changes, squashed):

- **`lib/transcript-search.ts`** — pure engine. `FindOptions { caseSensitive,
  wholeWord, grep }`, `FindMatch { row, start, end }`, `compileQuery` (literal-escape
  or grep source, `\b(?:…)\b` word wrap, `i` flag toggle, invalid → `null`),
  `search(rows, query, options, limit = DEFAULT_MATCH_LIMIT /* 5000 */)` —
  non-overlapping, row-then-offset order, zero-width skipped. Tests:
  `lib/__tests__/transcript-search.test.ts`.
- **`lib/dev-find-session.ts`** — `DevFindSession` [L02] store.
  `FindState { query, options, matches, activeIndex, wrapped, wrapDirection,
  wrapSeq }`; `setQuery` / `setOptions` / `setMatches` / `next` / `previous` /
  `clear`; constructor takes seed options. Tests:
  `lib/__tests__/dev-find-session.test.ts`.
- **`lib/transcript-search-index.ts`** — `buildTranscriptSearchRows(dataSource,
  streamingStore): string[]`. Projects `user` text, `assistant_text` (via
  `ensureParsed(streamingStore, "turn.${turnKey}.message.${messageKey}.text", text)`
  — the renderer's warm parse cache — then HTML→text through a scratch `<div>` with
  `.tugx-katex` subtrees removed and unfenced math stripped via
  `findInlineMathRanges`), `assistant_thinking`, `system_note`. `tool_use` and
  `shell_exchange` project `""` (this plan's scope debt). Ghost rows `""`.
- **`components/tugways/transcript-find-highlighter.ts`** —
  `TranscriptFindHighlighter`: two `Highlight` registries
  (`transcript-find-match` / `transcript-find-active`), `paint(input)` re-searches
  each match-bearing row's DOM textContent (`collectSearchableTextNodes` — currently
  the whole cell minus `.tugx-katex`; **this is the over-paint bug**),
  `rangeFromNodes` maps offsets to Ranges, `activeRangeRect()`, `flashActive()`
  (fixed-position ring overlay, `FLASH_MS = 640`), `clear()`. CSS:
  `components/tugways/transcript-find.css`.
- **`components/tugways/cards/dev-card-transcript.tsx`** — host wiring: `findSession`
  prop; `searchIndex` `useMemo` keyed on `[dataSource, streamingStore, codeSnapshot]`;
  100 ms debounced `findSession.setMatches(search(...))`; paint-on-snap effect with
  scroll-to-active (`scrollToIndex`, `block: "nearest"`), sticky-clear reveal
  (`--tugx-pin-stack-top` + 8px, against the
  `[data-tug-scroll-key="dev-card-transcript"]` scroller), then `flashActive`;
  `handleFindRenderedRangeChange` → `TugListView`'s `onRenderedRangeChange` repaints
  on window turnover. Also owns `ToolBlockExpansionState` (one per card, [A9] key
  `"tool-block-expansion"`, seeded via `useSavedComponentState`, captured via
  `useComponentStatePreservation`) and `ShellTurnCell` (shell rows: `BlockChrome`
  header carrying the command + `TerminalBlock` body inside
  `ToolBlockHistoryCollapse` keyed by `exchangeId`, `defaultCollapsed={false}`).
- **`components/tugways/tug-list-view.tsx`** — `getElementForIndex(index)` (cell
  element map) and `onRenderedRangeChange(range: TugListRenderedRange)` (rAF-coalesced).
- **`components/tugways/tug-prompt-entry.tsx`** — `ROUTE_FIND = "⌕"`;
  `RETURN_ACTION_BY_ROUTE["⌕"] = "newline"` (map membership also gates the ⇧⌘F
  `SELECT_ROUTE` value check); `routeAwareSubmitButtonMode` Find pose (always
  `{ kind: "submit", disabled: false }`); `performSubmit`'s Find branch
  (`findSession.next()`, before all send gates); the ⌕-gated `FIND_NEXT` /
  `FIND_PREVIOUS` responder handlers (⌘G / ⇧⌘G); the query-mirror `updateListener`
  (doc → `setQuery`, gated on route ⌕); `observeRouteWillChange` clear-on-leave and
  `observeRouteDidChange` re-seed-on-enter; the outlined `ChevronUp` Previous button;
  Z5's `ChevronDown` Find pose. Return/Shift+Return flow through the pane
  default-button deferral: in Find, Z5 is the sole default button, so the editor's
  submit gesture proxy-clicks it → `SUBMIT` action → `performSubmit`.
- **`components/tugways/chrome/dev-find-cluster.tsx`** (+`.css`) — Z4B cluster:
  `TugOptionGroup` (item values `"case"` / `"word"` / `"grep"`, 18px Lucide icons,
  `title` tooltips) + width-stabilized count chip (`TugStableOverlay`, alternates
  `["No results", "888 of 888"]`); reads the session via `useSyncExternalStore`;
  `useResponderForm` `setValueStringArray` slot maps `string[]` ↔ `FindOptions` →
  `setOptions` + `putFindOptions`.
- **`components/tugways/chrome/find-wrap-overlay.tsx`** (+`.css`) — wrap graphic in
  the card overlay, keyed on `wrapSeq`.
- **`components/tugways/chrome/dev-route-chrome-manifest.tsx`** — `find` chip slot;
  `routeChipKeys("⌕") === ["project", "find"]`.
- **`components/tugways/cards/dev-card.tsx`** — constructs `DevFindSession` seeded
  from `readFindOptions`; wires `DevFindCluster`, `FindWrapOverlay`, `findSession`
  into entry + transcript; `slashCommandSurfaces` and the `RUN_SLASH_COMMAND` handler
  live here (see #local-command-pipeline).
- **`components/tugways/keybinding-map.ts`** — ⌘F → `TUG_ACTIONS.FIND`; ⌘G/⇧⌘G →
  `FIND_NEXT`/`FIND_PREVIOUS`; ⇧⌘F → `SELECT_ROUTE "⌕"` (⇧⌘C/S/B are the sibling
  route chords).
- **`settings-api.ts`** — `readFindOptions(client)` / `putFindOptions(options)` at
  domain `dev.tugtool.find`, key `options` (per-field-validated JSON).

**Audit deltas this plan repairs:** no find app-test exists; no
`transcript-search-index` unit test exists; the painter over-paints chrome text in
match-bearing rows (count↔paint ordinal bug); shell rows and tool bodies project `""`.

#### Why the DOM-walk painter cannot search editors {#why-dom-walk-fails}

CM6 renders only the viewport (plus small overscan) into `contentDOM` — off-screen
lines are **absent from the DOM**. `file-block.tsx` documents this itself: it avoids
`view.coordsAtPos` because it "returns `null` for positions outside CM6's current
viewport" and uses `view.lineBlockAt` ("the height map … always covers the full
document"). Therefore a textContent walk over an embedded `tug-code-view` sees only
visible lines: the index (full file text) would count matches the painter cannot find,
and the per-row "k-th DOM hit = k-th index hit" ordinal mapping desyncs. CM6's own
search paints from the *document*, immune to virtualization — hence [P05].

#### Fold-prefix alignment {#fold-prefix-alignment}

`TerminalBlock`'s internal fold renders exactly the **first** `collapseThreshold`
(default 25, `DEFAULT_COLLAPSE_THRESHOLD` in `body-kinds/terminal-block.tsx`) lines of
its output; the hidden remainder is a suffix. So the DOM hits inside a folded terminal
are a strict **prefix** of the index hits for that segment — the k-th DOM hit is still
the k-th index hit for every mounted occurrence. Painting a folded terminal is
therefore ordinal-safe: paint what is there; a match beyond the prefix simply has no
Range until navigation unfolds it (#s04-find-target-registry). (`FileBlock`'s fold is
different — it unmounts CM6 entirely (`DEFAULT_COLLAPSE_THRESHOLD = 80` in
`body-kinds/file-block.tsx`); an editor segment in a folded file body has no paint
target until unfolded, which navigation does.) The `RETAINED_LINE_CAP` (10k lines) in
`TerminalBlock` bounds what the DOM can ever hold; the index projection for terminal
output must apply the same cap so count never exceeds what unfolding can reveal.

#### The local-command pipeline {#local-command-pipeline}

- **Registry:** `lib/slash-commands.ts` — `LocalSlashCommandSpec { name, description,
  takesArgs? }`; `LOCAL_SLASH_COMMANDS` (`as const satisfies readonly
  LocalSlashCommandSpec[]`) narrows `LocalCommandName` to a literal union;
  `matchLocalSlashCommand(text)` (regex `^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$`,
  rejects args on no-arg commands); `buildSlashCommandLine(text, atoms)` re-expands
  atom placeholders. `/btw` is the arg-bearing template:
  `{ name: "btw", description: "…", takesArgs: true }`.
- **Completion:** `cards/completion-providers/local-commands.ts` —
  `localCommandCompletionProvider(options?)` maps registry entries to `CompletionItem`s
  (`atom.type = "command"`, indistinguishable from Claude's commands until submit);
  optional `isOffered(name)` per-query gate (currently unused). Merged first-wins in
  `cards/use-dev-card-services.ts` `commandMatchProvider`, wrapped `wrapPositionZero`.
  **The popup is not route-aware today.**
- **Dispatch:** `performSubmit` ordering (all in `tug-prompt-entry.tsx`): ⌕ intercept →
  `?` intercept → **local-command split** (`matchLocalSlashCommand` → `sendToTarget(
  localCommandTargetId, { action: RUN_SLASH_COMMAND, value: { name, args } })`,
  history push, `editor.clear()`) → [D14] unknown-command notice → send gates →
  `$`-route `shellSessionStore.exec(submitText)` → `codeSessionStore.send(...)`.
  Consequence: local commands currently fire on `$` too (the split precedes shell
  dispatch), and never on `⌕` (the find intercept returns first).
- **Handling:** `cards/dev-card.tsx` — `slashCommandSurfaces:
  Record<LocalCommandName, (args: string) => void>` (exhaustive — adding a registry
  entry without a surface is a compile error); the `RUN_SLASH_COMMAND` handler on the
  `${cardId}-card-content` responder invokes `slashCommandSurfaces[payload.name]
  (payload.args)`. Mid-turn re-entry rides `action-dispatch.ts`'s [D108] path.
- **Shell exec:** `lib/shell-session-store.ts` `exec(command)` — trims, no-ops on
  empty, **silently refuses while an exchange is in flight** (`inflight !== null`),
  mints `sh-${seq}`, sends the `exec` verb; the transcript row appears when
  `exchange_started` echoes back (`ingestShellExchange`).

#### The sigil system (being removed) {#sigil-inventory}

- `components/tugways/tug-prompt-entry/route-prefix-extension.ts` — the whole feature:
  a CM6 `ViewPlugin` that watches for an insertion at `fromB === 0` and maps `doc[0]`
  through `aliasMap` → `setRoute`. It never strips the character.
- Install site: `tug-prompt-entry.tsx` `editorExtensions` `useMemo`
  (`createRoutePrefixExtension({ aliasMap: ROUTE_PREFIX_ALIAS, getCurrentRoute,
  setRoute })`); `ROUTE_PREFIX_ALIAS = { "❯": "❯", ">": "❯", "$": "$", "?": "?" }`
  (no `⌕` entry — Find never had a sigil, which is why typing `$` in a Find query
  switches to Shell).
- The **separate** submit-time strip: `stripLeadingRoutePrefix` / `computeSubmitText`
  (default param `ROUTE_PREFIX_ALIAS`) called in `performSubmit`, plus the atom
  “positions shift left by 1” adjustment beside it, and `computeSideQuestionArg`'s
  leading-`?` strip. Removed together per [P08].
- Tests: `tests/app-test/at0085-prompt-entry-route.test.ts` Test 4
  (`runPrefixTriggerScenario` — `app.nativeType("$")` asserts the route flips);
  `components/tugways/__tests__/tug-prompt-entry-strip-and-migrate.test.ts` pins
  `computeSubmitText` strip behavior (update/remove with the strip).
- Docs to update: `tuglaws/route-lifecycle.md` trigger-table row ("Typing a route
  prefix (`>` `$`) at editor offset 0"); `tuglaws/design-decisions.md` [D110] prefix-
  alias clause; `tuglaws/app-test-inventory.md` at0050/at0085 descriptions; the
  "hidden power-user feature" comment on `ROUTE_ITEMS` and the route-trigger list
  comment in `tug-prompt-entry.tsx`.
- Route reachability after removal (verified): Z4A popup lists all four routes
  (`ROUTE_ITEMS`); ⇧⌘C/S/B/F chords dispatch `SELECT_ROUTE` per `keybinding-map.ts`.
  Restore, history recall, and shell Share all call `setRoute` directly.

#### The Text card today {#text-card-today}

- `cards/text-card.tsx` — body-state machine; owns the **existing find bar state**
  (`findOpen` / `findQuery` / `findMatches` / `findInputRef`; `openFindBar` /
  `closeFindBar` / `updateFindQuery`) and renders the current **top strip**: a
  `TugInput` (`data-testid="text-card-find-input"`, Enter → `findNext`, Shift+Enter →
  `findPrevious`, Escape → close), a `TugLabel` "`{n} matches`" count, `ChevronUp` /
  `ChevronDown` / `X` `TugIconButton`s. Ready-state column order: `TextCardTopBar`
  (path + Save + gear — **stays**), find strip (**goes**), `TugTextCardEditor`,
  `TextCardStatusBar` (**stays**; the new bar docks above it). CSS:
  `cards/text-card.css` `.text-card-find-bar`.
- `components/tugways/tug-text-card-editor.tsx` — the third CM6 primitive (peer to
  `tug-text-editor` / `tug-code-view`); one `EditorView` over the whole doc;
  `TugTextCardEditorDelegate`: `setSearchQuery({ search, caseSensitive?, regexp?,
  wholeWord? })` (opens the hidden bundled search panel to init the highlighter, then
  dispatches a `SearchQuery`), `clearSearch()`, `findNext()` / `findPrevious()`,
  `getMatchCount()` (cursor iteration), `revealLine()` + reveal flash
  (`REVEAL_FLASH_MS = 900`). Responder registrations for `TUG_ACTIONS.FIND` (⌘F →
  `onFindRequested` → `openFindBar`), `FIND_NEXT`, `FIND_PREVIOUS` already exist.
  ⇧⌘F is the Dev card's route chord and stays a no-op here.

---

### Specification {#specification}

**Spec S01: Searchable-content model** {#s01-searchable-model}

- Marker: `data-tugx-findable` (present/absent; no value) on the *content container*
  of each searchable kind. The painter's tree walk accepts a text node iff it has a
  `data-tugx-findable` ancestor within the row cell AND is not inside `.tugx-katex`
  AND has no `[data-block-collapsed="true"]` ancestor. The collapse guard is
  load-bearing: markers are static DOM attributes while index gating is
  expansion-aware, and a collapsed block's always-mounted header still shows its
  marked command element — without the guard, a row holding a prose match plus a
  collapsed Bash/shell block whose visible command matches would over-paint and
  desync the active ordinal (the exact bug this spec exists to fix). The
  `data-block-collapsed` attribute already exists on the chrome root
  (`block-chrome.tsx`).
- Search units: each marked container is its own search unit. The painter searches
  each marked subtree's concatenated text **independently** (never concatenating
  across sibling marked containers), and the index searches each projected part
  independently to match. This kills phantom cross-block matches — the landed
  painter joins a whole cell's text nodes with no separator while the index joins
  parts with `"\n"`, so a query could match across two adjacent blocks in the DOM
  but never in the index. Consequence: a query never matches across container
  boundaries on either side, by construction. (Step 7's segment model formalizes
  the same rule.)
- Searchable kinds and their containers (each stamped where the component renders):
  1. Assistant markdown — `TugMarkdownBlock` root (`components/tugways/tug-markdown-block.tsx`).
  2. Thinking — the thinking body container (`DevThinkingBlock`, locate its prose root
     in `components/tugways/cards/` blocks).
  3. User rows — the user text container in `dev-card-transcript.tsx`'s user cell.
  4. System notes — the note body container.
  5. Shell exchange (expanded): the command element passed to `BlockChrome`'s
     `command` slot by `shell-exchange-block.tsx`, and `TerminalBlock`'s line content
     region (mark the content wrapper, NOT the footer/fold cue/truncation banner).
  6. Bash tool block (expanded): same two kinds (command + terminal content).
  7. Expanded tool markdown/text results — the `TugMarkdownBlock` rendered by
     `default-tool-block.tsx`'s result branch (marking the component's root covers
     this automatically via (1)); any other wrapper rendering `TugMarkdownBlock` as a
     result body inherits it the same way.
- NOT marked (chrome, stays unsearchable): `BlockHeader` name/identity/summary/timing,
  notice bands, footer badges, fold cues, truncation banners, `JsonTreeBlock`,
  `DiffBlock`, gutters, the `.tugx-katex` subtrees (excluded even inside markers).
- **Checklist obligation:** adding a searchable kind = mark the container + project
  the same text in the index (same order) + add a fidelity-fixture case. Record this
  rule in the marker's docstring.
- Index symmetry: `transcript-search-index.ts` projects, per row, exactly the marked
  kinds in DOM order: user text; per-message assistant markdown / thinking / note;
  for expanded (per `ToolBlockExpansionState.resolve(toolUseId,
  collapseDefaultForMessage(message))`) `tool_use` messages — Bash command +
  ANSI-stripped output, markdown/text results, Read file content (as an `editor`
  segment, Spec S02); for expanded `shell_exchange` — command + ANSI-stripped output
  (capped at `RETAINED_LINE_CAP` lines to mirror `TerminalBlock`). ANSI stripping is a
  new pure `stripAnsi(text)` in `lib/ansi/` (regex escape-sequence removal; do NOT
  round-trip through `ansiToHtml` + DOM).

**Spec S02: Segmented row projection & match model** {#s02-segment-model}

- `RowSegment = { kind: "dom", text: string } | { kind: "editor", key: string,
  text: string }` — `key` is the owning `toolUseId`. The index becomes
  `buildTranscriptSearchSegments(dataSource, streamingStore, expansion):
  RowSegment[][]` (row-indexed). Each searchable unit of a row is its own segment in
  DOM order — one `dom` segment per marked container (per Spec S01's search-unit
  rule, which #step-2 already enforces on both sides), one `editor` segment per
  embedded editor at its DOM position.
- `transcript-search.ts` is unchanged (pure strings). A new thin layer (in
  `transcript-search-index.ts` or a sibling) runs `search` per segment and assembles
  `SegmentedFindMatch = FindMatch & { segment: number, segmentKind, segmentKey? }` in
  row-then-segment-then-offset order. `DevFindSession` stores the flat ordered list;
  `next`/`previous`/count are unchanged.
- Painter partition: `dom` matches → existing Custom-Highlight walk (now scoped per
  Spec S01); `editor` matches → the CM6 delegate path (Spec S03). Per-row DOM ordinal
  mapping now counts only that row's `dom`-segment matches.
- Projection cap: an `editor` segment's text is projected in full (file bodies are
  the point); the global `DEFAULT_MATCH_LIMIT` (5000) already bounds total matches.

**Spec S03: Editor-segment paint & navigation (file bodies)** {#s03-editor-paint}

- Source text: `ReadStructuredFile.content` via `read-tool-block.tsx`'s
  `composeFileData` inputs — identical bytes to what `FileBlock` feeds
  `TugCodeView`.
- Paint: when the paint pass encounters a mounted row containing `editor`-segment
  matches, it resolves the block's registered find target (Spec S04) and calls
  `delegate.setSearchQuery({ search: query, caseSensitive, regexp: grep, wholeWord })`
  — CM6's own highlighter paints all in-editor matches, virtualization-proof. When a
  query/option change or `clear()` occurs, every previously-touched delegate gets
  `clearSearch()` (the highlighter keeps a touched-set).
- Active match: navigating to an `editor` match with in-segment ordinal k walks
  `SearchQuery.getCursor()` to the k-th occurrence and selects/reveals it (extend the
  `tug-code-view` delegate with `selectMatch(ordinal)` — reveal via existing scroll
  machinery; CM6's `.cm-searchMatch-selected` styling + the code-view's flash/ping is
  the active treatment; the transcript-level ring overlay is not used inside editors).
- Un-mounted rows: exactly like dom matches — counted always, painted when the row
  mounts (navigation mounts it via `scrollToIndex` first).

**Spec S04: Find-target registry & unfold-on-navigate** {#s04-find-target-registry}

- A per-card registry (React context provided by `DevTranscriptHost`, consumed by
  body kinds): `FindTargetRegistry { register(key: string, target: FindTarget):
  () => void; resolve(key): FindTarget | null }` with `FindTarget { unfold(): void;
  codeView?: TugCodeViewDelegate | null }`. Registration in `useLayoutEffect` [L03];
  `key` = `toolUseId` (tool blocks) / `exchangeId` (shell rows).
- `FileBlock` registers `{ unfold: () => setCollapsed(false), codeView:
  codeViewRef.current-resolver }` (it already holds `codeViewRef`); `TerminalBlock`
  registers `{ unfold }` for its internal fold. Registration is additive chrome-free
  plumbing — no visual change.
- Navigation flow to a hidden match: `scrollToIndex(row)` → resolve target →
  `unfold()` if folded → next frame, paint (CM6 query or DOM prefix now extended) →
  reveal + flash. Whole-block collapse is NOT auto-toggled by navigation (matches in
  collapsed blocks don't exist per [P04]).

**Spec S05: `FindSurface` and the shared cluster** {#s05-find-surface}

- `FindSurface` (new `lib/find-surface.ts`):
  `{ subscribe(cb): () => void; getSnapshot(): { options: FindOptions; count: number;
  activeOrdinal: number | null; capped: boolean }; setOptions(next: FindOptions):
  void }`.
- `TugFindCluster` (new `components/tugways/tug-find-cluster.tsx` +`.css`): the
  option group + count chip extracted from `dev-find-cluster.tsx`, consuming a
  `FindSurface` (+ `focusGroup`/`focusOrder` passthrough). `dev-find-cluster.tsx`
  becomes a thin adapter: `DevFindSession` → `FindSurface` (count =
  `matches.length`, activeOrdinal = `activeIndex`), preserving its
  `putFindOptions` write-through and exact current appearance.
- The Text card implements `FindSurface` over `TugTextCardEditorDelegate.getMatchInfo()`
  + local option state seeded from `readFindOptions` ([P10]).

**Spec S06: One-shot slash commands** {#s06-one-shot-commands}

- Registry (`lib/slash-commands.ts`): add
  `{ name: "shell", description: "Run one shell command from here", takesArgs: true,
  codeRouteOnly: true }` and
  `{ name: "find", description: "Find in the transcript from here", takesArgs: true,
  codeRouteOnly: true }`; add `codeRouteOnly: true` to `btw`. New optional field on
  `LocalSlashCommandSpec`, surfaced on completion items.
- Offering: in `tug-prompt-entry.tsx`, wrap the host-supplied `/` completion provider
  so items carrying `codeRouteOnly` are filtered out when
  `routeLifecycle.getRoute() !== "❯"` (the entry owns the live route; the provider
  composition in `use-dev-card-services.ts` stays route-blind). The
  local-commands provider stamps the flag on its items (extend
  `localCommandCompletionProvider`).
- Submission: the local split in `performSubmit` skips a matched command whose spec
  is `codeRouteOnly` when the route isn't `❯` (falls through to the route's native
  path — on `$`, `/shell ls` reaches the shell literally).
- Surfaces (`dev-card.tsx` `slashCommandSurfaces`):
  - `shell: (arg)` — empty arg → no-op with a pane bulletin ("usage: /shell
    <command>"); if `shellSessionStore` snapshot has an exchange in flight → pane
    bulletin ("a shell command is already running") — `exec` would silently drop it
    otherwise; else `shellSessionStore.exec(arg)`. Route untouched; the exchange row
    arrives via `exchange_started` exactly as a `$` submit.
  - `find: (arg)` — empty arg → open nothing, pane bulletin ("usage: /find <query>");
    else `findSession.setQuery(arg)` then `findSession.next()` ([P07]).
- One-shot find lifecycle ([P07], [Q02]): `FIND_NEXT`/`FIND_PREVIOUS` handlers in
  `tug-prompt-entry.tsx` re-gate from `route === ROUTE_FIND` to
  `findSessionRef.current` having matches; `performSubmit` clears a non-empty find
  session at the top of a normal (non-⌕) submission; Escape per [Q02]; ⌕-route
  observers keep their existing ownership.

**Spec S07: Text-card find bar** {#s07-text-find-bar}

- Composition (new `cards/text-card-find-bar.tsx` +`.css`): a bottom-docked row
  rendered between `TugTextCardEditor` and `TextCardStatusBar` when open — a
  single-line query `TugInput` (reuse `data-testid="text-card-find-input"`),
  `TugFindCluster` (Spec S05), an outlined `ChevronUp` previous + filled `ChevronDown`
  next `TugPushButton` pair mirroring the Dev Find Z5 pair, and Escape/`X` close.
  Styled on the `.tug-prompt-entry-toolbar` composition (spacers flanking the
  cluster; lg icon buttons trailing) using existing tokens — no new token family.
- Behavior: ⌘F (existing `TUG_ACTIONS.FIND` → `onFindRequested`) opens + focuses;
  Escape closes + `clearSearch()`; Enter → `findNext`, Shift+Enter → `findPrevious`
  (input-local keydown, as the current strip does); ⌘G/⇧⌘G already registered on the
  editor responder. Typing updates `setSearchQuery` live with the current options;
  toggling options re-runs the query and persists via `putFindOptions` ([P10]).
- Delegate extension (`tug-text-card-editor.tsx`): `getMatchInfo(): { count: number;
  activeOrdinal: number | null; capped: boolean }` — cursor walk capped at
  `DEFAULT_MATCH_LIMIT` ([Q01]), active ordinal by comparing cursor ranges to the
  current selection.
- The old top strip (its JSX in `text-card.tsx`, `.text-card-find-bar` CSS) is
  deleted, not hidden.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Expansion version + listeners | local-data | `ToolBlockExpansionState` gains `version`/`subscribe`; host `useSyncExternalStore` keys the index memo | [L02] |
| Searchable markers | structure (static DOM) | `data-tugx-findable` attributes stamped at render | [L06] (no state) |
| Segment matches / active index | local-data | `DevFindSession` (existing store, richer match type) | [L02] |
| CM6 in-editor match paint | appearance | delegate `setSearchQuery` → CM6 decorations | [L06] |
| Find-target registry | structure | React context + `useLayoutEffect` register/unregister | [L03], [L07] |
| One-shot find lifecycle clears | structure | `performSubmit` / Escape keymap / route observers | [L03] |
| Text find bar open/query | structure + local-data | React state in `text-card.tsx` (existing `findOpen` pattern) | — |
| Text find options | local-data | seeded `readFindOptions`, written `putFindOptions` | [L02]-adjacent (tugbank) |
| Route-gated command offering | local-data | completion filter reads `routeLifecycle.getRoute()` at query time | [L07] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/find-surface.ts` | `FindSurface` interface (+ `DevFindSession` adapter helper) |
| `tugdeck/src/components/tugways/tug-find-cluster.tsx` (+`.css`) | Shared option group + count chip (Spec S05) |
| `tugdeck/src/components/tugways/cards/text-card-find-bar.tsx` (+`.css`) | Text card bottom find bar (Spec S07) |
| `tugdeck/src/lib/ansi/strip-ansi.ts` | Pure ANSI escape stripper for index projection |
| `tugdeck/src/components/tugways/cards/blocks/find-target-registry.tsx` | Registry context + hooks (Spec S04) |
| `tugdeck/src/lib/__tests__/transcript-search-index.test.ts` | Projection unit tests (DOM-free kinds) |
| `tests/app-test/at02xx-transcript-find-fidelity.test.ts` | The fidelity gate (number per inventory) |
| `tests/app-test/at02xx-find-one-shot-commands.test.ts` | `/shell` + `/find` behavior |
| `tests/app-test/at02xx-text-card-find-bar.test.ts` | Text card bar behavior |

#### Symbols to modify {#symbols}

| Symbol | Location | Notes |
|--------|----------|-------|
| `route-prefix-extension.ts` | `tugways/tug-prompt-entry/` | **delete** |
| `ROUTE_PREFIX_ALIAS`, `stripLeadingRoutePrefix`, `computeSubmitText` strip, atom-offset shift, `computeSideQuestionArg` `?`-strip | `tug-prompt-entry.tsx` | remove ([P08]) |
| `ToolBlockExpansionState` | `cards/blocks/expansion-state.ts` | + `version`, `subscribe` (bump/notify in `set`; `seed` does not notify) |
| `buildTranscriptSearchRows` → `buildTranscriptSearchSegments` | `lib/transcript-search-index.ts` | Spec S01/S02; takes expansion state |
| `TranscriptFindHighlighter` | `tugways/transcript-find-highlighter.ts` | findable-marker walk; segment partition; delegate touched-set |
| `DevFindSession` match type | `lib/dev-find-session.ts` | `SegmentedFindMatch` |
| `FIND_NEXT`/`FIND_PREVIOUS` gates, Escape keymap, `performSubmit` clears, completion route filter | `tug-prompt-entry.tsx` | [P06]/[P07]/[Q02] |
| `LocalSlashCommandSpec` + registry | `lib/slash-commands.ts` | `codeRouteOnly`; `shell`/`find` entries |
| `localCommandCompletionProvider` | `cards/completion-providers/local-commands.ts` | stamp `codeRouteOnly` on items |
| `slashCommandSurfaces` | `cards/dev-card.tsx` | `shell` + `find` surfaces |
| `TugCodeViewDelegate` | `tugways/tug-code-view.tsx` | + `selectMatch(ordinal)` (Spec S03) |
| `TugTextCardEditorDelegate` | `tugways/tug-text-card-editor.tsx` | + `getMatchInfo()` (Spec S07) |
| `FileBlock`, `TerminalBlock` | `tugways/body-kinds/` | marker stamps; registry registration |
| `shell-exchange-block.tsx`, `bash-tool-block.tsx`, `default-tool-block.tsx`, `TugMarkdownBlock`, user/thinking/note containers | various | marker stamps (Spec S01) |
| `dev-find-cluster.tsx` | `tugways/chrome/` | rebase onto `TugFindCluster` |
| Text card find strip | `cards/text-card.tsx` (+`.css`) | remove; mount new bar |
| at0085 Test 4; strip-and-migrate unit test | `tests/app-test/`, `tugways/__tests__/` | retire with sigils |
| `tuglaws/route-lifecycle.md`, `design-decisions.md` [D110], `app-test-inventory.md` | `tuglaws/` | sigil-removal doc sweep |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose |
|----------|---------|
| Unit (`bun:test`, no DOM) | `stripAnsi`; segment projection for DOM-free kinds (user/thinking/note/shell command+output, expansion gating on/off); segment→flat match assembly ordering; `matchLocalSlashCommand` with `codeRouteOnly`; `FindSurface` adapter |
| App-test | Fidelity gate: per-row, per-segment match **order** alignment index↔DOM on a fixture (markdown constructs, mixed-segment row, chrome-adjacent text, shell exchange, expanded markdown result, file body); e2e find flows; one-shot commands; text-card bar; sigil-removal regression (typing `$`/`?` at offset 0 stays text) |
| Build | `./node_modules/.bin/vite build` from `tugdeck/` every step; `just app-test` at integration |

**What stays out of tests:** mock-store / jsdom render tests (banned); pixel-diffing
the flash or CM6 decorations (assert store state, ranges, attributes — WebKit paints a
spurious wash for collapsed-Range highlights); CM6 search internals (upstream);
markdown→text fidelity as a unit test (needs DOM entity decoding + WASM init — that is
exactly why the gate is an app-test).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass — every step. Update the Step Status Ledger and
> the step's checkboxes as part of landing it ([P11]). Verification commands run from
> `tugdeck/` with project-local binaries (see #dependencies).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Remove first-character route switching | done | 27078d9f9 |
| #step-2 | Opt-in searchable markers + scoped painter + projection tests | done | 5760bc917 |
| #step-3 | Fidelity app-test gate | done | a401444dd |
| #step-4 | Expansion notify | done | b18d08d64 |
| #step-5 | Shell rows searchable | done | 1bac0e566 |
| #step-6 | Expanded tool results searchable | done | 96b1d9199 |
| #step-7 | Segmented projection refactor | done | 3471a772a |
| #step-8 | File bodies via CM6 + unfold registry | done | 7a7f7d178 |
| #step-9 | `/shell` one-shot + route gating | done | 08ef50f47 |
| #step-10 | `/find` one-shot | done | 9edb3ed14 |
| #step-11 | `FindSurface` + `TugFindCluster` extraction | done | 11f34cf77 |
| #step-12 | Text card bottom find bar | done | ac6fdbdcc |
| #step-13 | Integration checkpoint | done | (verification only) |

#### Step 1: Remove first-character route switching {#step-1}

**Commit:** `route(subtraction): remove first-character route switching and submit-time sigil strip`

**References:** [P08] Remove sigils, (#sigil-inventory, #success-criteria)

**Artifacts:** deletion of `route-prefix-extension.ts`; `tug-prompt-entry.tsx` cleanup; law updates.

**Tasks:**
- [x] Delete `tugdeck/src/components/tugways/tug-prompt-entry/route-prefix-extension.ts`; remove its import and the `createRoutePrefixExtension(...)` entry from `editorExtensions` in `tug-prompt-entry.tsx`.
- [x] Remove `ROUTE_PREFIX_ALIAS`, `stripLeadingRoutePrefix`, `computeSubmitText`'s strip behavior (and the atom “positions shift left by 1” adjustment in `performSubmit`), and `computeSideQuestionArg`'s leading-`?` strip; simplify call sites so submit text is the draft text unmodified.
- [x] Remove at0085 Test 4 (`runPrefixTriggerScenario` + its registration) and update/retire `__tests__/tug-prompt-entry-strip-and-migrate.test.ts`'s strip cases. (at0050's prefix-flip scenario reworked the same way.)
- [x] Doc sweep: `tuglaws/route-lifecycle.md` trigger-table row; `tuglaws/design-decisions.md` [D110] prefix-alias clause; `tuglaws/app-test-inventory.md` at0050/at0085 descriptions; the `ROUTE_ITEMS` "hidden power-user feature" comment and route-trigger list comment in `tug-prompt-entry.tsx`.

**Tests:**
- [x] Updated unit tests pass (`bun test`); at0085 remaining scenarios pass.
- [x] Added at0085 scenario: type `$HOME` at offset 0 → route unchanged, text present in the doc.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build`
- [ ] Live: on `⌕`, type `$HOME` — route stays `⌕`, text reads `$HOME`; on `❯`, a message beginning with `>` submits with the `>` intact. (User-vet at build handoff.)

---

#### Step 2: Opt-in searchable markers + scoped painter + projection tests {#step-2}

**Depends on:** #step-1

**Commit:** `find(scope): opt-in data-tugx-findable markers; painter scoped to marked content`

**References:** [P02] Opt-in markers, Spec S01, Risk R01, (#landed-inventory)

**Tasks:**
- [x] Stamp `data-tugx-findable` on the prose containers — via a new `findable` prop on `TugMarkdownBlock` set at the transcript call sites (assistant text, thinking, wake chip, user body through `TugAtomMarkdownBody`), plus the compaction divider label directly.
- [x] Rework `collectSearchableTextNodes` in `transcript-find-highlighter.ts`: accept text nodes only inside a `data-tugx-findable` ancestor, still rejecting `.tugx-katex` subtrees within (and `.tug-atom-chip-host` — chip SVG labels), and rejecting any node under a `[data-block-collapsed="true"]` ancestor (Spec S01's collapse guard). Document the two-sided checklist obligation in the module docstring.
- [x] Per-unit search (Spec S01): the painter enumerates marked containers in DOM order and re-searches each container's text independently; the index searches each projected part independently via new `searchRowParts` (`buildTranscriptSearchRows` now returns `string[][]`). Per-row ordinal mapping counts hits across the row's units in order.
- [x] Verify the index's projected kinds equal the marked kinds — this surfaced two landed fidelity gaps beyond the plan: thinking and user bodies render as MARKDOWN but were projected raw, and `system_note` rendering is per-source (compact = verbatim label, scheduled = markdown, other = not rendered). All corrected: both markdown kinds project through `ensureParsed` (thinking on the renderer-warmed turn identity; user bodies on an index-owned identity, with the renderer's leading-`>` display strip mirrored and `U+FFFC` atom chars removed to match the excluded chip hosts).
- [x] Add `lib/__tests__/transcript-search-index.test.ts` covering the DOM-free projections and `searchRowParts` ordering/boundary semantics.

**Tests:**
- [x] New projection unit tests; existing find unit tests unchanged.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build`
- [ ] Live: search a term that appears in a row's prose AND its tool-block header (e.g. a tool name) — highlight count in that row equals its index count; chrome text never highlights. (User-vet at build handoff; also gated by #step-3's app-test.)

---

#### Step 3: Fidelity app-test gate {#step-3}

**Depends on:** #step-2

**Commit:** `find(test): per-row order-alignment fidelity app-test`

**References:** [P11] Verification spine, Spec S01, Risk R04, (#test-plan-concepts)

**Tasks:**
- [x] New app-test `at0221-transcript-find-fidelity.test.ts` ([AT0221] registered): a fixture JSONL replayed via real `spawn_session(resume)`; painted-highlight casing sequence vs hand-computed source order proves per-row order alignment across markdown constructs, a mixed thinking+text row, a markdown user body, and chrome-adjacent text. (Backfilled missing [AT0217]–[AT0220] inventory entries and repaired at0050's stale segment-control helpers while touching those files.)
- [x] Fixture case for the search-unit rule: `seamaseamb` across the thinking→text boundary — zero matches; `seama` alone — one. (The collapse-guard fixture case lands in #step-5, where a marked element inside a collapsible block first exists.)
- [x] Assert whole-transcript count with off-screen matches (scroll-independent) via the long virtualized fixture; ⌘G navigation mounts + paints each end without changing the count, and wraps.

**Tests:** the app-test itself.

**Checkpoint:**
- [x] `just app-test at0221` green (plus at0085/at0050 re-runs); `vite build` clean from Step 2.

---

#### Step 4: Expansion notify {#step-4}

**Depends on:** #step-2

**Commit:** `blocks(expansion): version + listeners on ToolBlockExpansionState`

**References:** old-plan Risk R02 heritage, Spec S01, Risk R03, (#state-zone-mapping)

**Tasks:**
- [x] `expansion-state.ts`: add `version: number` (monotonic), `subscribe(cb): () => void`; bump+notify in `set` only when the resolved value actually changes; `seed` stays silent. Keep the class pure (no DOM/React).
- [x] `dev-card-transcript.tsx`: `useSyncExternalStore` over the instance; the search-index `useMemo` keys on the version (projection still ignores tool content until #step-5/#step-6 — this step is pure plumbing).

**Tests:**
- [x] Extend `cards/blocks/__tests__/expansion-state.test.ts`: subscribe/notify on real change, silence on no-op set and on seed, unsubscribe.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build`

---

#### Step 5: Shell rows searchable {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `find(scope): shell exchange command + output searchable`

**References:** [P04] Expansion-gated, Spec S01, (#fold-prefix-alignment)

**Tasks:**
- [x] Add `lib/ansi/strip-ansi.ts` (`stripAnsi`, pure regex).
- [x] Index: project expanded (`ToolBlockExpansionState.resolve(exchangeId, false)`)
      `shell_exchange` messages as TWO search units in DOM order (Spec S01) — the
      command, then `stripAnsi(output)` capped at `RETAINED_LINE_CAP` lines;
      collapsed → nothing.
- [x] Markers: the command element in `shell-exchange-block.tsx`'s `command` slot; `TerminalBlock`'s content region (content only — not footer/fold cue/truncation banner).
- [x] Known interim limitation (until #step-8): a match beyond a folded terminal preview counts and is scrolled to, but paints only after manual unfold — note it in the step's commit body.

**Tests:**
- [x] Projection unit tests: shell row expanded/collapsed, ANSI stripped, line cap honored.
- [x] Extend the fidelity app-test fixture with a shell exchange (run a real `$` command in the fixture session); assert order alignment and folded-prefix paint agreement.
- [x] Collapse-guard fixture case (Spec S01): a prose match in a row adjacent to a COLLAPSED exchange whose visible header command contains the query — painted count equals index count (the collapsed command paints nothing) and the active ordinal lands on the prose occurrence.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`
- [x] Live: search text occurring in a shell command and in its output — counted, painted, navigable; collapsing the exchange removes its matches from the count (expansion notify at work).

---

#### Step 6: Expanded tool results searchable {#step-6}

**Depends on:** #step-5

**Commit:** `find(scope): expanded tool markdown/text results + bash command/output searchable`

**References:** [P04] Expansion-gated, Spec S01, (#landed-inventory)

**Tasks:**
- [x] Index: for expanded `tool_use` messages (`resolve(toolUseId,
      collapseDefaultForMessage(message))` — import from
      `cards/blocks/tool-collapse-defaults.ts`), project: Bash `input.command` +
      `stripAnsi` of its terminal output — projected **in the DOM's render order**:
      `renderTerminal` in `body-kinds/terminal-block.tsx` emits all stdout lines then
      all stderr lines, so a terminal fed separate streams must be projected
      stdout-then-stderr, not interleaved (shell exchanges are immune — their
      `output` is one pre-combined string); and `default-tool-block`'s markdown text
      result (`pickOutputBody(...).kind === "markdown"` branch). For the markdown
      result, parse through `ensureParsed` with a new `tool.${toolUseId}.result`
      identity. Note honestly what this buys: the renderer (`TugMarkdownBlock` in
      static `initialText` mode) parses via `renderIncremental`, NOT `ensureParsed`,
      so this cache entry is **index-owned** — the first index build pays one parse
      and repeat builds are cache hits; there is no renderer-warmed entry to
      free-ride on (unlike assistant prose). Calling raw
      `parseMarkdownToSanitizedBlocks` per build remains banned.
- [x] Markers: `bash-tool-block.tsx` command element; `default-tool-block.tsx` result-markdown branch (inherited from `TugMarkdownBlock` root marker — verify no double-mark).
- [x] JSON trees / diffs / agent blocks remain unmarked + unprojected (#non-goals).

**Tests:**
- [x] Projection unit tests: bash expanded/collapsed; markdown-result extraction; JSON-result exclusion.
- [x] Fidelity fixture: an expanded Bash block and an expanded markdown-result block; assert alignment and that collapsing removes matches live.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`
- [x] Live: query matching an expanded tool result — count + paint + nav correct; collapse → gone; expand → back (no manual refresh).

---

#### Step 7: Segmented projection refactor {#step-7}

**Depends on:** #step-6

**Commit:** `find(model): segmented row projection; segment-tagged matches`

**References:** [P03] Segments, Spec S02, Risk R01, (#step-3)

**Tasks:**
- [x] `transcript-search-index.ts`: `buildTranscriptSearchSegments(...)`; one `dom` segment per marked container in DOM order (Spec S02) — the segment texts are byte-identical to #step-2's per-unit search strings, so the produced matches are behavior-identical to the pre-refactor engine.
- [x] Match assembly layer producing `SegmentedFindMatch`; `DevFindSession` typed to it; painter reads per-row `dom`-segment matches for its ordinal math (no `editor` segments exist yet).
- [x] `transcript-search.ts` untouched.

**Tests:**
- [x] Unit: assembly ordering (row → segment → offset); dom-only rows produce matches identical to the pre-refactor engine (fixture comparison test).
- [x] Fidelity app-test unchanged and green — the regression gate for this refactor.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`

---

#### Step 8: File bodies via CM6 + unfold registry {#step-8}

**Depends on:** #step-7

**Commit:** `find(scope): Read file bodies counted from store, painted via CM6 search; unfold-on-navigate`

**References:** [P05] File bodies, Spec S03, Spec S04, Risk R02, (#why-dom-walk-fails, #fold-prefix-alignment)

**Tasks:**
- [x] `find-target-registry.tsx` (Spec S04); provide from `DevTranscriptHost`; register in `FileBlock` (unfold + code-view delegate) and `TerminalBlock` (unfold).
- [x] Index: expanded Read blocks project `structured_result.file.content` as an `editor` segment keyed by `toolUseId` (narrow via `read-tool-block.tsx`'s exported `ReadStructuredResult` shape or a shared helper — do not duplicate the narrowing).
- [x] `tug-code-view.tsx`: add `selectMatch(ordinal)` to the delegate (SearchQuery cursor walk → select + reveal k-th match).
- [x] Highlighter: on paint, drive registered code-view delegates for rows with `editor` matches (`setSearchQuery` mapping `FindOptions` → `SearchQuery`); maintain a touched-set and `clearSearch()` all on clear/query-change; skip editor segments in the DOM walk.
- [x] Navigation: active match in an `editor` segment → `scrollToIndex` → `unfold()` if needed → `selectMatch(inSegmentOrdinal)`; active match beyond a folded terminal prefix → `unfold()` → repaint → flash (completes #step-5's interim limitation).
- [x] Count chip counts editor-segment matches (free — they're in the flat list).

**Tests:**
- [x] Unit: editor-segment projection (expanded/collapsed; content bytes verbatim).
- [x] Fidelity fixture: an expanded Read block longer than both folds (>80 lines, matches beyond CM6's viewport); assert count includes them; navigate → unfolds, selects, reveals the exact occurrence; collapse block → matches gone.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`
- [x] Live: search a term deep inside a long expanded Read file — "N of M" includes it; Next lands on and highlights the exact line; leaving Find clears the in-editor tint.

---

#### Step 9: `/shell` one-shot + route gating {#step-9}

**Depends on:** #step-1

**Commit:** `commands(one-shot): /shell from the Code route; codeRouteOnly gating`

**References:** [P06] One-shot registry, Spec S06, (#local-command-pipeline)

**Tasks:**
- [x] `lib/slash-commands.ts`: `codeRouteOnly?: boolean` on the spec; `shell` entry; `btw` gains the flag.
- [x] `localCommandCompletionProvider`: stamp the flag on emitted items; `tug-prompt-entry.tsx`: route-gated filter over the `/` provider (route ≠ `❯` hides flagged items); `performSubmit` split skips flagged commands off-`❯`.
- [x] `dev-card.tsx` surface: `shell` per Spec S06 (usage bulletin on empty arg; in-flight bulletin per `shellSessionStore` snapshot; else `exec(arg)`).

**Tests:**
- [x] Unit: `matchLocalSlashCommand` + gating table; registry exhaustiveness compiles.
- [x] App-test (landed with #step-10's at0222): on `❯`, submit `/shell echo find-foundations-probe` → a `#s` shell row lands with the output; route still `❯`; on `$`, `/` completion offers no `/shell`.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`

---

#### Step 10: `/find` one-shot {#step-10}

**Depends on:** #step-9

**Commit:** `commands(one-shot): /find runs transcript find from the Code route`

**References:** [P07] One-shot find, [Q02] Escape, Spec S06, (#landed-inventory)

**Tasks:**
- [x] Registry `find` entry + `dev-card.tsx` surface (`setQuery` + `next()`; usage bulletin on empty arg).
- [x] `tug-prompt-entry.tsx`: re-gate `FIND_NEXT`/`FIND_PREVIOUS` on session-has-matches; clear a lingering session at the top of non-⌕ `performSubmit`; Escape clear per [Q02] (resolve the ordering live and record the resolution in this plan).
- [x] Verify the wrap overlay and highlighter behave with route `❯` (they key on the session, not the route — confirm no route-gated early-outs in `dev-card-transcript.tsx`'s paint path).

**Tests:**
- [x] App-test: `/find <fixture term>` on `❯` → highlights + first-match flash + route unchanged; ⌘G advances; a subsequent normal submit clears highlights; Escape clears.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`
- [x] Live sanity: `/find` a common word, cycle ⌘G across off-screen rows, submit a normal prompt — highlights gone.

---

#### Step 11: `FindSurface` + `TugFindCluster` extraction {#step-11}

**Depends on:** #step-2

**Commit:** `find(ui): extract FindSurface + TugFindCluster from the dev cluster`

**References:** [P01] Two engines, Spec S05, (#landed-inventory)

**Tasks:**
- [x] `lib/find-surface.ts`; `tugways/tug-find-cluster.tsx` (+`.css`) extracted from `dev-find-cluster.tsx` (option group, icons, tooltips, stable-overlay chip — pixel-identical).
- [x] `dev-find-cluster.tsx` becomes the `DevFindSession` adapter (count/activeOrdinal from state; `putFindOptions` write-through preserved).
- [x] Update `__tests__/dev-route-chrome-manifest.test.ts` only if imports move; no behavior change.

**Tests:**
- [x] Unit: the adapter's snapshot mapping (counts, `No results`, capped display).

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build`
- [x] Live: the ⌕ route's cluster is visually and behaviorally unchanged.

---

#### Step 12: Text card bottom find bar {#step-12}

**Depends on:** #step-11

**Commit:** `text-card(find): bottom-docked find bar with full cluster parity; top strip removed`

**References:** [P09] Text-card bar, [P10] Global options, [Q01] Ordinal cost, Spec S07, (#text-card-today)

**Tasks:**
- [x] `tug-text-card-editor.tsx`: `getMatchInfo()` per Spec S07 ([Q01] cap).
- [x] `cards/text-card-find-bar.tsx` (+`.css`): composition per Spec S07 over a `FindSurface` implementation backed by the delegate + option state seeded from `readFindOptions`, written through `putFindOptions`.
- [x] `text-card.tsx`: delete the top-strip JSX and its `.text-card-find-bar` CSS; mount the new bar between the editor and `TextCardStatusBar`; keep `findOpen` open/close state, `onFindRequested={openFindBar}` (⌘F), Escape close + `clearSearch()`.
- [x] Options changes re-run the live query with new `SearchQuery` flags.

**Tests:**
- [x] App-test: open a file in a Text card; ⌘F opens the bottom bar (assert placement above the status bar via DOM order); type a query → "N of M" chip correct; toggle Case → count changes; next/prev + ⌘G cycle with reveal; Escape closes and clears; reopen ⌘F — options persisted; the old `data-testid` input renders in the bottom bar only.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test`
- [x] Live: find in a large file feels immediate ([Q01] confirm); the bar visually reads as the Dev entry's sibling.

---

#### Step 13: Integration checkpoint {#step-13}

**Depends on:** #step-3, #step-5, #step-6, #step-8, #step-10, #step-12

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [x] Walk every success criterion live; reconcile the Step Status Ledger and all checkboxes; mark `dash/find-route.md` superseded-note accurate. (The two remaining unchecked "Live:" lines in steps 1–2 are the user-vet items at build handoff; their behaviors are also gated by at0085/at0221.)

**Tests:**
- [x] Full `just app-test` sweep: VERDICT PASS (46/47 files green, 83/83 tests; at0185 corpus baseline skips by design). Full `bun test`: 4259 pass / 0 fail.

**Checkpoint:**
- [x] `./node_modules/.bin/tsc --noEmit` && `bun test` && `./node_modules/.bin/vite build` && `just app-test` — all green.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A correct, tested transcript Find (prose + shell + expanded tool
results + file bodies) with sigil-free routing, one-shot `/shell` and `/find` from the
Code route, and a Text card bottom find bar with full cluster parity — all sharing the
`FindSurface` vocabulary.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Every #success-criteria item verified (each names its step; live user-vet pending at build handoff).
- [x] The fidelity app-test exists (at0221, 4 scenarios), covers every searchable kind shipped, and passes.
- [x] No first-character route switching anywhere; laws updated ([D110], route-lifecycle.md, app-test inventory).
- [x] `tsc --noEmit`, `bun test`, `vite build`, `just app-test` all green.
- [x] Step Status Ledger complete with commits; all task checkboxes reconciled.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Smart plain-⌘F in the Dev card (enter Find when no CM6 editor owns find).
- [ ] `DiffBlock` / `JsonTreeBlock` / `AgentTranscriptBlock` searchability.
- [ ] Find-and-replace (Text card first).
- [ ] Find in additional card types via `FindSurface`.
