<!-- devised against tuglaws/devise-skeleton.md v4 -->

## Changeset Entry Blocks — the structural conversion {#changeset-entry-blocks}

**Purpose:** Re-home the tool-call block-grammar chrome to a neutral tugways location and
re-express the Changeset card's entries as top-level `BlockChrome` sections with sticky
pin-stack wayfinding, retiring the `TugAccordion` + fixed-TOC structure. This is the
pre-Lens structural step; the Lens card host, section registry, and standalone-card
retirement are a separate later plan.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Dev card transcript establishes the house display paradigm: one scrolling surface of
sections whose expandable blocks nest, with sticky headers that telescope via the pin
stack (`--tugx-pin-stack-top` + `--tugx-block-header-height`; see #pin-stack-contract).
After Milestone M03B of `dash/changesets-plan.md` (steps 16h–16n), the Changeset card
speaks this grammar *inside* its entries — file rows are `BlockChrome` file blocks with
embedded `DiffBlock` bodies and monochrome `+N −M` badges, and the commit composer is one
block over `TugMessageEditor` — but the card still wears its M03A-era top-level
structure: a controlled `TugAccordion type="multiple"` of entries under a fixed TOC
`TugListView` with click-to-reveal scroll logic.

This plan finishes the conversion. The grammar chrome moves out of
`tugdeck/src/components/tugways/cards/blocks/` — a path that reads as "transcript-only"
and is how the M03A divergence happened — to a neutral home, and the entries themselves
become `BlockChrome` blocks in a plain scroll, with sticky headers as the wayfinding.
Decisions already made upstream (do not re-litigate): the TOC is retired with no
replacement affordance in this plan; the card remains a standalone card here (the Lens
host absorbs it later, clean break, no deck migration).

#### Strategy {#strategy}

- Two workstreams, strictly ordered: the re-home first (pure `git mv` + import sweep,
  zero behavior change, independently shippable), then the card structure conversion.
- The re-home's split criterion is grammar-vs-wrapper: host-agnostic chrome moves;
  tool-specific wrappers and the dispatch registry stay in `cards/blocks/` ([P01]).
- The entry conversion applies the M03B collapse pattern one level up: card-local
  `ToolBlockCollapseContext.Provider` per entry block over plain `useState`, no
  persistence, no timing provider ([P02]).
- Sticky wayfinding reuses the proven agent-transcript clearance-capture CSS pattern
  for the nested pin stack — no new mechanism ([P03]).
- The baseline for Workstream B is the **as-built** card after M03B *and* M04 step 21
  (the `DashActions` body flow: Join/Release + join preview + "Resolve with AI"). That
  flow is body content and stays in the body untouched; the swap only changes entry
  *structure*, so nothing in it is dropped ([P06]).

#### Success Criteria (Measurable) {#success-criteria}

- Every module listed in Table T01 lives under
  `tugdeck/src/components/tugways/blocks/`; a grep for
  `components/tugways/cards/blocks/<any T01 module>` returns nothing; the transcript,
  gallery, permission dialog, and Changeset card behave identically before/after
  (curated `just app-test` green, no visual change).
- The Changeset card renders one `BlockChrome` per entry in a plain scroll: no
  `TugAccordion` import, no TOC (`ChangesetTocDataSource` / `ChangesetTocCell` /
  `changeset-toc-entry` testid gone), no reveal-scroll effect (grep
  `changeset-card.tsx` for `TugAccordion`, `pendingRevealRef`, `TugListView` — all
  absent).
- Scrolling inside an expanded entry pins that entry's header at the top of
  `.changeset-scroll`; an expanded file block's header stacks *below* the stuck entry
  header, not under it (verify visually and via at0228's reveal assertions clearing
  the stuck header, per the sticky-header reveal gotcha).
- Entries a snapshot introduces open themselves exactly once; a user's collapse sticks
  across snapshot recomputes (manual: collapse an entry, touch a file in its project,
  entry stays collapsed).
- Toolbar Expand all / Collapse all drive entry-block collapse; the dash Join/Release
  affordances and the join preview flow from M04 step 21 work unchanged in the new
  structure (re-run the step-21 app-test leg).
- `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test` and `just app-test`
  green at every step.

#### Scope {#scope}

1. `git mv` of the grammar modules (Table T01) to
   `tugdeck/src/components/tugways/blocks/` + repo-wide import sweep + module-docstring
   path updates.
2. Changeset entries re-expressed as `BlockChrome` entry blocks; `TugAccordion`,
   the fixed TOC, and the TOC reveal logic deleted; toolbar rewired to entry-block
   collapse; entry test identity (`data-entry-id` / `data-session-id` /
   `data-project-dir`) preserved on the entry-block wrapper.
3. Sticky pin-stack CSS for the two-level (entry → file) header telescoping inside
   `.changeset-scroll`.
4. Migration of the M04 step-21 dash affordances (Join/Release, join preview,
   Resolve-with-AI) into entry-block header actions / body content.
5. App-test adaptation (at0228 + any M04-added dash tests) to the new selectors and
   sticky-header navigation.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The Lens card, the lens section registry/contract, `ChangesetSection` packaging, the
  Hello World second registrant, retirement of the standalone Changeset card, and any
  find / follow-bottom / PTY capability hooks — all deferred to the Lens (M3) plan.
- Re-planning any M03B artifact (file blocks, `TugMessageEditor`, composer block,
  `TugDiffDocument` restyle, `BlockHeader` `leading`/optional-verb) — those are built
  by `dash/changesets-plan.md` steps 16h–16n and are consumed here as-is.
- Splitting `types.ts` into body-kind vs tool-wrapper contracts (see [P01]) — deferred
  to the Lens plan if it proves needed.
- Any change to feeds, stores, verbs, or Rust — this plan is tugdeck-only.
- A TOC replacement affordance (outline popover etc.) — decided out; sticky headers
  are the wayfinding.

#### Dependencies / Prerequisites {#dependencies}

- **Milestone M03B** of `dash/changesets-plan.md` (steps 16h–16n) — **MET, on main**
  (commit `81ba28c79`). Verified as-built: file blocks are `ChangesetFileBlock`
  (`changeset-card.tsx`, a verb-less `BlockChrome` wrapped in a
  `ToolBlockCollapseContext.Provider` over the entry's `expandedFiles` set, stamped
  `data-testid="changeset-file-block"`); the composer is one `BlockChrome` over
  `TugMessageEditor`; `BlockHeader` carries `leading?` (the `tool-call-header-leading`
  slot) and optional `toolName?`; `TugMessageEditor` lives at
  `tugways/tug-message-editor.tsx` with a `restoreState(text)` / `clear()` handle.
- **Milestone M04** of `dash/changesets-plan.md` (steps 17–22) — **MET, on main**
  (commits `5a52fc36b`, `735aea856`). Verified as-built: step 21's dash integration is
  the `DashActions` flow component (`changeset-card.tsx`) — a body-level state machine
  (idle → resolving → resolved/partial candidate list → clean/conflict preview →
  confirm-join / release-confirm / Resolve-with-AI), backed by
  `lib/changeset-join-store.ts` (`useChangesetJoinResolve`), covered by
  `tests/app-test/at0229-changeset-dash-join.test.ts`. **This is body content, not
  header actions** — see [P06].
- `dash/markdown-text-styling.md` — complete and merged (relevant only in that
  `TugTextEditor` substrate patterns are settled).

#### Constraints {#constraints}

- Tuglaws: verify against `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`,
  `tuglaws/component-authoring.md`; name the touched laws in commits ([L02], [L06],
  [L11], [L20], [L24], [L26] at minimum). Compose real Tug* components; no
  localStorage; no height estimates.
- Warnings are errors repo-wide; `bun`, never npm; tugdeck HMR is live but
  `bunx vite build` is mandatory before any step is called done — the re-home's import
  sweep is exactly the class of change that passes dev esbuild and breaks the
  production rollup (splash-hang failure mode).
- Real app-tests only (no jsdom/mock render tests).
- Artifact hygiene: no plan-step numbers in code, no rationale/backstory comments.

#### Assumptions {#assumptions}

- M03B and M04 are **on main** (see #dependencies); every symbol this plan cites was
  verified against the as-built card, not against the upstream plan's planned names.
  The one place the as-built diverged from the earlier proposal — dash affordances are
  a body-level flow, not header actions — is folded into [P06] and #step-2 rather than
  left as a reconciliation task.
- The `@/` import alias resolves to `tugdeck/src/`, so the sweep is a mechanical
  specifier-prefix replacement plus relative-import fixes inside `cards/blocks/`.
- at0228 (`tests/app-test/at0228-changeset-aggregate.test.ts`) is the primary
  changeset app-test; `at0229-changeset-dash-join.test.ts` is M04's dash-join leg.
  Both adapt in place; neither is rewritten from scratch.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, stable labels (`[P01]`, `[Q01]`, `T01`,
`R01`), `**Depends on:**` lines with `#step-N` anchors, and rich `**References:**`
lines on every execution step. Never cite line numbers — cite anchors and symbols.
Plan-local decisions use `P##`; `[D##]` refers to the global
`tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does `types.ts` move wholesale despite its transcript-typed imports? (DECIDED) {#q01-types-move}

**Question:** `cards/blocks/types.ts` holds both layer contracts — `BodyKindProps`
(grammar) and `ToolBlockProps` (tool-wrapper) — and imports
`CodeSessionStore` / `ToolUseMessage` (type-only) from `@/lib/code-session-store`.
Moving it drags transcript type names into the neutral home; splitting it creates two
`types.ts` files and more churn.

**Resolution:** DECIDED (see [P01]) — move wholesale. The imports are type-only (zero
runtime coupling), the re-home's purpose is the *path* reading as transcript-only, and
a split is real design work that belongs to the Lens plan if the section contract needs
it.

#### [Q02] Where does at0228's session enumeration live once the TOC is gone? (DECIDED) {#q02-session-enumeration}

**Question:** at0228 enumerates sessions via
`[data-testid="changeset-toc-entry"][data-session-id]` (its `SESSION_IDS_JS`). The TOC
is deleted.

**Resolution:** DECIDED (see [P04]) — the entry-block wrapper carries the same identity
attributes the accordion item carries today (`data-testid="changeset-entry"`,
`data-entry-id`, `data-project-dir`) **plus** `data-session-id` for session entries
(today that attribute lives only on the TOC row). `SESSION_IDS_JS` switches its
selector to `[data-testid="changeset-entry"][data-session-id]`; every other at0228
selector keyed on `changeset-entry` + `data-entry-id` survives unchanged.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Import sweep breaks the production rollup while dev passes | high | med | `bunx vite build` in the #step-1 checkpoint; sweep is mechanical (Table T01 prefix replace) | any splash-hang report |
| Stuck entry headers paint transparent over scrolled content on the card surface | med | low | Risk R01 | visual bleed-through in manual pass |
| Losing M04 step-21 dash affordances in the structure swap | high | low | [P06] `DashActions` stays in the body untouched; `at0229-changeset-dash-join.test.ts` re-run in #step-2 checkpoint | any dash control missing post-swap |
| Open-once semantics regress (entries re-open on every snapshot) | med | low | keep `seenSectionsRef` verbatim; collapse map is keyed by entry id ([P02]) | entry pops open after user collapsed it |

**Risk R01: Sticky header surface on the card background** {#r01-sticky-surface}

- **Risk:** `.tool-call-header` is styled for the transcript surface; stuck over the
  Changeset card's scrolled content it must paint an opaque background or file rows
  will show through it.
- **Mitigation:** the chrome brings its own tokens ([L20]) — verify the header's
  background token renders correctly on the card surface during #step-3's manual
  pass; if the transcript header is transparent-by-inheritance, add the background on
  the card-scoped entry-block class (appearance-only CSS, [L06]), not on the shared
  chrome.
- **Residual risk:** theme-specific contrast quirks; caught by the existing
  `bun run audit:theme-contrast` budget if tokens change (none are expected to).

---

### Design Decisions {#design-decisions}

#### [P01] The grammar re-homes to `tugways/blocks/`; wrappers stay in `cards/blocks/` (DECIDED) {#p01-re-home}

**Decision:** The host-agnostic grammar modules (Table T01) move via `git mv` from
`tugdeck/src/components/tugways/cards/blocks/` to
`tugdeck/src/components/tugways/blocks/` (keeping the `block-bits/` subdirectory and
moving the two grammar test files). Tool-specific wrappers (every `*-tool-block.tsx`
+ `.css` + their tests), `tool-collapse-defaults.ts`, and the dispatch registry
(`cards/dev-assistant-renderer-dispatch.ts`, which never lived in `blocks/`) stay
where they are. `types.ts` moves wholesale per [Q01].

**Rationale:**
- The split criterion is *who may depend on it*: anything a non-transcript host
  (Changeset card today, Lens sections later) composes is grammar; anything keyed to
  a Claude tool name is wrapper.
- `cards/blocks/` reading as "transcript-only" is the documented cause of the M03A
  divergence; the neutral path is the fix, not a new abstraction.
- Wholesale `types.ts` move: type-only imports, zero runtime coupling ([Q01]).

**Implications:**
- Import sweep: every specifier
  `@/components/tugways/cards/blocks/<moved-module>` becomes
  `@/components/tugways/blocks/<moved-module>`; relative imports *inside*
  `cards/blocks/` that point at moved siblings (e.g. `./block-chrome`) become
  `../../blocks/<module>`. Known importer surface at authoring time: the ten
  `body-kinds/*.tsx` files, `cards/dev-card-transcript.tsx`,
  `cards/gallery-transcript-copy.tsx`, `chrome/dev-caution-badge.tsx`,
  `chrome/dev-session-init-banner.tsx`, `transcript-find-highlighter.ts`,
  `lib/transcript-search-index.ts` (+ its test),
  `src/__tests__/assistant-rendering-fixture-replay.test.ts`, every remaining
  `cards/blocks/*-tool-block.tsx`, and whatever M03B/M04 added (the sweep is a grep,
  not this list).
- Module docstrings update their `@module` paths; no other content changes.

#### [P02] Entry blocks: `BlockChrome` + card-local collapse providers, open-once preserved (DECIDED) {#p02-entry-blocks}

**Decision:** Each `ChangesetItem` renders as a `BlockChrome` (optional-verb form)
wrapped in a `ToolBlockCollapseContext.Provider` whose `ToolBlockCollapseHandle`
(`{collapsed, toggle, toolUseId}` from the re-homed `blocks/collapse-context.tsx`) is
driven by card-local state: a `collapsedEntries: ReadonlySet<string>` (entry ids)
`useState` in `ChangesetCardContent`, replacing the accordion's `openKeys`. The
existing `seenSectionsRef` open-once semantics carry over verbatim: an entry id a
snapshot introduces is *not* added to `collapsedEntries` (open by default, once), and
a user's collapse persists across recomputes because the set is keyed by id. No
`ToolBlockExpansionContext`, no persistence, no `ToolCallMetaProvider`.

**Rationale:**
- This is exactly the M03B file-block collapse pattern
  (`dash/changesets-plan.md` #step-16k "Collapse wiring") one level up — same
  handle, same collapse-by-unmount, same [L24]/[L26] zone assignment.
- A standalone `BlockChrome` with no provider renders no chevron and always mounts
  its body (`block-chrome.tsx`: `disclosure = blockCollapse !== null ? {…} :
  undefined`) — the provider is load-bearing, not optional.
- Inverting to a *collapsed*-set (vs the accordion's open-list) makes open-once the
  default state rather than an effect that mutates open keys.

**Implications:**
- Header mapping: `leading` = the existing `ItemGlyph` (live dot / dash mark / dashed
  circle); identity (`target`) = the entry title (`itemTitle`), no `toolName`; detail
  slot = `itemSubtitle` (project · branch · ahead/behind, keeping the spelled-out
  `aheadBehindTitle` tooltip); summary slot = `resultSummary={{kind:"text", text:
  <itemStatusHint>.text}}` ("N files" / "clean" / "not a git repo"); disclosure
  chevron = entry collapse. **`headerActions` is empty for entry blocks** (the
  chevron is the only trailing affordance) — see the body-content rule below.
- **All of `EntryBody` stays in the body, untouched** ([P06]): the entry-diff cluster
  (`entryDiffActionsRow` — Expand All / Collapse All + whole-entry pop-out, with its
  as-built gates `entryDescriptor !== null && diffablePaths.length > 0`, and
  `> 1` for Expand/Collapse All), the `DashActions` flow, the commit composer, the
  receipt, the non-repo body, and the clean state all render as `BlockChrome`
  children exactly as today. This plan converts entry *structure* (accordion →
  `BlockChrome`), not entry *content* — lifting body content into header slots would
  mean hoisting `EntryBody`'s local `expandedFiles` / commit / diff state up a level,
  which is churn this plan explicitly avoids. Header-slot placement of the entry-diff
  cluster is a deferred polish, not part of this structural conversion.
- `toolUseId` = the entry id (`item.id`) — synthetic, stable, and it lands on the
  chrome root as `data-tool-use-id` for free.
- The entry body (`EntryBody` — M03B file blocks, composer block, receipt, non-repo
  body, clean state) mounts unchanged as the chrome's children.
- Toolbar Expand all / Collapse all set `collapsedEntries` to empty / all-ids (and
  keep marking `seenSectionsRef`); the "N sessions" count is unchanged.
- The `useResponderForm` accordion binding (`toggleSectionMulti`) is deleted; entry
  collapse toggles are plain `onToggle` callbacks through the collapse handle. The
  chevron is a `BlockFoldCue` inside the chrome — controls still emit through the
  chrome's own wiring; no new responder form is needed ([L11] untouched for the
  entry level).

#### [P03] Nested pin stack via the agent-transcript clearance-capture pattern (DECIDED) {#p03-pin-stack}

**Decision:** Entry-block headers stick at the top of `.changeset-scroll` (the
chrome's `.tool-call-header` is already `position: sticky; top:
var(--tugx-pin-stack-top, 0)` — with the variable unset in the card, that is top 0).
For file-block headers to telescope *below* a stuck entry header, the card CSS
mirrors the `.tugx-agent` / `.tugx-agent-entries` pattern from
`body-kinds/agent-transcript-block.css`: capture the clearance on the entry-block
root into an intermediate variable, then republish it as the subtree's
`--tugx-pin-stack-top` on the body wrapper —

```css
.changeset-entry-block {
  --changeset-entry-pin-clearance: calc(
    var(--tugx-pin-stack-top, 0px) + var(--tugx-block-header-height, 0px)
  );
}
.changeset-entry-block > [data-slot="tool-block-body"] {
  --tugx-pin-stack-top: var(--changeset-entry-pin-clearance);
}
```

**Rationale:**
- `BlockChrome` already writes the live measured header height into
  `--tugx-block-header-height` on its root (rAF-coalesced `ResizeObserver` in
  `block-chrome.tsx` — see #pin-stack-contract); no JS is added.
- The intermediate variable is load-bearing: folding into `--tugx-pin-stack-top`
  directly would self-reference and break — the agent-transcript CSS documents this
  exact trap.
- This is the proven nesting mechanism (agent blocks telescope to depth 4+ with it).

**Implications:**
- `.changeset-entry-block` is a `className` passed to the entry `BlockChrome`; the
  selector targets the chrome's own `data-slot="tool-block-body"` wrapper.
- Appearance-only CSS ([L06]); no React state, no new tokens ([L20] — the two
  `--changeset-*` vars are card-scoped plumbing, not a token vocabulary).
- Reveal-style scrolls and app-test assertions must clear stuck headers (the
  sticky-header reveal gotcha) — relevant to at0228's file-diff leg, which M03B
  already adapts; re-verify under the now-sticky entry header.

#### [P04] TOC retirement and test identity (DECIDED) {#p04-toc-retirement}

**Decision:** Delete the fixed TOC and its machinery from `changeset-card.tsx` /
`.css`: `ChangesetTocDataSource`, `ChangesetTocCell`,
`CHANGESET_TOC_CELL_RENDERERS`, the `TugListView` usage + import, `itemStatusHint`'s
TOC-only consumers (the hint itself survives as the header summary text),
`.changeset-toc*` CSS, the `changeset-toc-entry` testid, and the TOC reveal logic
(`pendingRevealRef`, the scroll-into-view effect keyed on `openKeys`, `revealEntry`,
`tocDelegate`, `tocDataSource`). The entry-block wrapper takes over test identity:
`data-testid="changeset-entry"`, `data-entry-id`, `data-project-dir`, and (new there)
`data-session-id` for session entries ([Q02]).

**Rationale:**
- Decided upstream: sticky headers are the wayfinding; the TOC was compensating for
  the accordion's lack of them.
- Keeping the existing `changeset-entry` testid + data attributes on the new wrapper
  minimizes at0228 churn to exactly one selector (the session enumeration).

**Implications:**
- at0228 changes: `SESSION_IDS_JS` re-targets per [Q02]; any TOC-click navigation leg
  becomes a direct interaction with the entry block (scroll + chevron), honoring
  stuck-header clearance.
- `TugListRow` import leaves the card; `tug-list-view` is no longer imported by the
  card at all (the Lens M3 plan reintroduces a list-view spine at the host level).

#### [P05] The scroller stays a plain overflow div (DECIDED) {#p05-plain-scroller}

**Decision:** `.changeset-scroll` remains the card's plain `overflow-y: auto` div.
No `TugListView`, no follow-bottom, no windowing.

**Rationale:**
- The `TugListView(inline)` spine is the Lens host's concern (M3); adopting it now in
  the standalone card would be churn the Lens plan immediately redoes.
- Sticky positioning needs only a scrolling ancestor; the plain div provides it.

**Implications:**
- Scroll state preservation stays whatever the card has today (none beyond the
  browser's); the Lens plan owns `scrollKey`-grade preservation.

#### [P06] M04 dash affordances stay in the entry body, untouched (DECIDED) {#p06-dash-inventory}

**Decision:** The M04 step-21 dash integration — the `DashActions` component in
`changeset-card.tsx` — renders in the entry **body** and is carried over **unchanged**
by this plan. It is not split across header/body slots.

**Rationale:**
- Verified against the as-built card (main, `5a52fc36b` / `735aea856`): `DashActions`
  is not a pair of discrete buttons but a stateful flow — idle action row (Join /
  Release) → resolving → resolved / partial candidate list → clean preview
  (`changeset-dash-preview-clean`) or conflict preview
  (`changeset-dash-preview-conflicts`) → confirm-join / release-confirm /
  Resolve-with-AI — driven by `lib/changeset-join-store.ts`
  (`useChangesetJoinResolve`). It renders in the body for every dash branch,
  including the clean/no-files branch where there is no file list at all.
- Prying that state machine apart into a header cluster + body panes would be pure
  churn with no design benefit; body content is structure-agnostic, so it survives the
  accordion → `BlockChrome` swap by simply remaining `EntryBody` children.
- Test alignment falls out for free: `tests/app-test/at0229-changeset-dash-join.test.ts`
  scopes every dash selector inside the `changeset-entry` body
  (`changeset-dash-join`, `-preview-clean`, `-preview-conflicts`, `-confirm-join`,
  `-release`, `-resolve`), so body placement needs **zero** selector changes there —
  only the entry block keeping its body mounted while open (see #step-2, eager-fetch
  invariant).

**Implications:**
- #step-2's inventory task is a confirmation pass (dash flow present and functional
  post-swap), not a relocation task.
- The commit-message composer's own `toolName` ("Join message" for dash entries) is
  unrelated to `DashActions` and is untouched (it is the composer `BlockChrome`, not
  the entry `BlockChrome`).

---

### Deep Dives {#deep-dives}

#### The pin-stack contract (verified) {#pin-stack-contract}

- `blocks/block-header.css` (post-move path): `.tool-call-header { position: sticky;
  top: var(--tugx-pin-stack-top, 0); }` — every chrome header is sticky against the
  nearest scrolling ancestor, offset by the inherited pin variable (default 0).
- `blocks/block-chrome.tsx`: a `useLayoutEffect` + rAF-coalesced `ResizeObserver`
  writes the live measured header height into `--tugx-block-header-height` on the
  chrome **root** (deliberately no synchronous seed — that read/write interleaving
  was an O(n²) mount cost in big transcripts; do not "fix" it). It re-measures across
  collapse toggles.
- `tug-transcript-entry.tsx` writes `--tugx-pin-stack-top` = its participant-header
  height onto the transcript entry root — that is the transcript's L0. The Changeset
  card has no participant header; its L0 offset is simply the unset default (0), so
  entry headers stick flush at the scrollport top.
- `body-kinds/agent-transcript-block.css` is the nesting template: `.tugx-agent`
  captures `--tugx-agent-pin-clearance: calc(var(--tugx-pin-stack-top, 0) +
  var(--tugx-block-header-height, …))`; `.tugx-agent-entries` republishes it as
  `--tugx-pin-stack-top` for the subtree. The two-step capture avoids the CSS
  self-reference cycle. [P03] copies this shape.

#### The collapse contract (verified) {#collapse-contract}

- `blocks/collapse-context.tsx` exports `ToolBlockCollapseContext`
  (`React.Context<ToolBlockCollapseHandle | null>`), `ToolBlockCollapseHandle`
  (`{collapsed, toggle, toolUseId, …}`), `ToolBlockHistoryCollapse` (the transcript's
  persisted wrapper — NOT used here), `ToolUseIdContext`, `ToolCallMetaProvider`.
- `BlockChrome` renders a disclosure chevron **only** when the context is non-null;
  `forceExpanded` pins open and disables (not a toggle). While collapsed the body
  subtree is unmounted; the chrome's mount identity is untouched across the toggle
  ([L26]).
- `data-tool-use-id` on the chrome root comes from the handle's `toolUseId` — the
  entry id serves ([P02]).

#### Import-sweep inventory (verified at authoring time) {#import-sweep}

62 files under `tugdeck/src` import from `cards/blocks/`; the subset importing
*moved* modules is enumerated in [P01]'s implications. The authoritative sweep at
implementation time is:
`grep -rn "components/tugways/cards/blocks/" tugdeck/src tugdeck/tests tests/` then
rewrite only the specifiers whose module basename is in Table T01 (wrapper imports
like `cards/blocks/edit-tool-block` stay). CSS files do not cross-import between
these modules (each `.tsx` imports its own `.css`), so the sweep is TS/TSX-only.

---

### Specification {#specification}

**Table T01: Modules that move to `tugdeck/src/components/tugways/blocks/`** {#t01-moved-modules}

| Module (from `cards/blocks/`) | Includes |
|---|---|
| `block-chrome.tsx` | + `block-chrome.css` |
| `block-header.tsx` | + `block-header.css` |
| `block-notice.tsx` | + `block-notice.css` |
| `block-bits/` | `block-body`, `block-disclosure`, `block-field-row`, `block-pre` (+ each `.css`), `index.ts` |
| `collapse-context.tsx` | — |
| `expansion-state.ts` | + `__tests__/expansion-state.test.ts` |
| `find-target-registry.tsx` | — |
| `middle-ellipsis-path.tsx` | + `middle-ellipsis-path.css` |
| `tool-file-ref.tsx` | + `tool-file-ref.css` |
| `tool-result-summary.ts` | + `__tests__/tool-result-summary.test.ts` |
| `types.ts` | wholesale, per [Q01] |

Everything else in `cards/blocks/` stays: all `*-tool-block.tsx/.css`,
`tool-collapse-defaults.ts`, and the remaining `__tests__/` files.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Per-entry collapse (`collapsedEntries` set) | local-data (ephemeral UI) | `useState` in `ChangesetCardContent`, fed to per-entry `ToolBlockCollapseContext.Provider`s; collapse-by-unmount with stable chrome mount identity | [L24], [L26] |
| Open-once seen-entries set | local-data (ephemeral UI) | `useRef<Set<string>>` (`seenSectionsRef`, carried over verbatim) | [L24] |
| Sticky header offsets (pin stack) | appearance | CSS variables (`--tugx-block-header-height` written by the chrome's existing ResizeObserver; card-scoped clearance vars per [P03]) — no React state | [L06] |
| Entry header summary/detail text | derived at render | pure functions over the `useChangesetAll()` snapshot (existing `itemTitle` / `itemSubtitle` / `itemStatusHint`) | [L02] (read) |

No new persistent state; no storage; no new stores; no feed changes.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/blocks/*` | Table T01 modules, moved via `git mv` (not new content) |

#### Symbols to add / modify / delete {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| import specifiers for T01 modules | modify | repo-wide (see #import-sweep) | mechanical sweep, #step-1 |
| `ChangesetEntryBlock` (or equiv.) | component (new) | `tugways/cards/changeset-card.tsx` | the `BlockChrome` + collapse-provider + identity-attr wrapper per [P02]/[P04]; exact name implementer's choice |
| `collapsedEntries` | state (new) | `ChangesetCardContent` | replaces `openKeys`; [P02] |
| `TugAccordion` / `TugAccordionItem` usage + import | delete | `changeset-card.tsx` | verified as-built: the top-level entry structure is the only accordion use in the card (M03B put file collapse on `ToolBlockCollapseContext`, not a nested accordion) |
| `ChangesetTocDataSource`, `ChangesetTocCell`, `CHANGESET_TOC_CELL_RENDERERS`, `tocDataSource`, `tocDelegate`, `revealEntry`, `pendingRevealRef` + reveal effect | delete | `changeset-card.tsx` | [P04] |
| `EntryTrigger` | delete | `changeset-card.tsx` | its content redistributes into the header slots per [P02] |
| accordion `useResponderForm` binding (`toggleSectionMulti`) | delete | `ChangesetCardContent` | [P02] |
| `.changeset-toc*`, `.changeset-entry-trigger*` CSS | delete | `changeset-card.css` | [P04] |
| `.changeset-entry-block` + pin-clearance rules | CSS (new) | `changeset-card.css` | [P03]; Risk R01 background rule if needed |
| `SESSION_IDS_JS` selector | modify | `tests/app-test/at0228-changeset-aggregate.test.ts` | [Q02] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (real app)** | Drive the live Tug.app; assert real DOM via the harness | The structure swap: entry blocks, collapse, sticky clearance, dash flows |
| **bun unit** | Existing store/lib suites | Must stay green through both workstreams (no new unit surface) |
| **Build gates** | `bunx tsc --noEmit`, `bunx vite build`, `bun test` | Every step checkpoint |

#### What stays out of tests {#test-non-goals}

- jsdom / mock render tests — banned repo-wide.
- Pixel/screenshot comparison of sticky behavior — the DOM/geometry assertions in the
  adapted app-test legs plus manual verification are stabler (and a collapsed
  highlight-range screenshot has a known WebKit wash artifact).
- Re-testing M03B/M04 behaviors beyond their existing legs — those suites already
  cover the guts this plan re-parents; the goal here is "nothing regressed", proven
  by the curated sweep.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land per the repo git policy (user
> commits, or the implement skill's dash-worktree flow).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Re-home the block grammar to `tugways/blocks/` | done | `2f0b6a52a` |
| #step-2 | Entries become BlockChrome; accordion + TOC retired | done | `8bad106c0` |
| #step-3 | Sticky pin-stack wayfinding | done | `f8cf0d4d0` |
| #step-4 | Integration checkpoint | done | — (verification only) |

#### Step 1: Re-home the block grammar to `tugways/blocks/` {#step-1}

**Commit:** `refactor(tugdeck): re-home the block grammar to tugways/blocks`

**References:** [P01] Re-home, [Q01] types move, Table T01, (#import-sweep)

**Artifacts:**
- `git mv` of every Table T01 module (with `.css` companions, `block-bits/`, and the
  two listed test files) from `tugdeck/src/components/tugways/cards/blocks/` to
  `tugdeck/src/components/tugways/blocks/`.
- Repo-wide import sweep per #import-sweep: `@/components/tugways/cards/blocks/<T01>`
  → `@/components/tugways/blocks/<T01>`; relative sibling imports inside the
  remaining `cards/blocks/` wrappers become `../../blocks/<module>`; moved modules'
  own relative imports to *staying* modules (if any) become
  `../cards/blocks/<module>` — the grep decides, not this list.
- `@module` docstring paths updated in every moved file. No content changes beyond
  paths.

**Tasks:**
- [ ] `git mv` (history-preserving), never copy+delete.
- [ ] Sweep with the #import-sweep grep; rewrite only T01-basename specifiers.
- [ ] Confirm no CSS cross-imports needed changing (expected none).
- [ ] Zero behavior change — no component, prop, token, or test-logic edits.

**Tests:**
- [ ] Entire existing bun suite green unmodified (the two moved test files run from
      their new location).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test` (curated sweep — transcript, gallery, changeset card all
      visually and behaviorally unchanged)
- [ ] `grep -rn "components/tugways/cards/blocks/" tugdeck/src tests | grep -v -E "(tool-block|tool-collapse-defaults)"` returns nothing

---

#### Step 2: Entries become BlockChrome; accordion + TOC retired {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): changeset entries become BlockChrome sections; TOC + accordion retired`

**References:** [P02] Entry blocks, [P04] TOC retirement, [P05] Plain scroller,
[P06] Dash affordances in body, [Q02] Session enumeration, (#collapse-contract,
#state-zone-mapping, #symbols)

**Artifacts:**
- **Confirm the dash flow first** ([P06]): a pass over the as-built `DashActions` +
  `lib/changeset-join-store.ts` to confirm its every branch/testid, so the swap can
  be shown to preserve it. `DashActions` stays in the entry body unchanged — this is
  a confirmation pass, not a relocation.
- The entry-block wrapper component per [P02]: `ToolBlockCollapseContext.Provider`
  (handle `{collapsed: collapsedEntries.has(id), toggle, toolUseId: id}`) around a
  `BlockChrome` (optional-verb; `leading` = `ItemGlyph`; identity = `itemTitle`;
  detail = `itemSubtitle` + tooltip; summary = `itemStatusHint` text; `headerActions`
  omitted — the chevron is the only trailing affordance; `className="changeset-entry-block"`),
  on a wrapper element stamped `data-testid="changeset-entry"`, `data-entry-id`,
  `data-project-dir`, `data-session-id` (session entries) per [P04]/[Q02]. `EntryBody`
  mounts **unchanged** as children — the entry-diff cluster (`entryDiffActionsRow`),
  `DashActions`, the commit composer, receipt, non-repo body, and clean state all
  stay in the body exactly as today ([P06]).
- `ChangesetCardContent` reworked: `collapsedEntries` set state (open-once via the
  verbatim `seenSectionsRef` pattern — snapshot-new ids are simply never in the set);
  toolbar Expand all / Collapse all drive the set; the accordion `useResponderForm`
  binding, `openKeys`, `TugAccordion` usage, and the whole TOC + reveal apparatus
  deleted per [P04] / #symbols.
- `changeset-card.css`: `.changeset-toc*` and `.changeset-entry-trigger*` families
  deleted; `.changeset-head` keeps the toolbar only.
- at0228 adapted: `SESSION_IDS_JS` re-targets `[data-testid="changeset-entry"][data-session-id]`
  per [Q02] (today it selects `changeset-toc-entry`); every other at0228 selector
  keys on `changeset-entry` + `data-entry-id` and is unchanged; any TOC-interaction
  leg becomes direct entry-block interaction (scroll + chevron, honoring stuck-header
  clearance). `at0229-changeset-dash-join.test.ts` re-runs unmodified (its selectors
  are body-scoped — see Tests).

**Tasks:**
- [ ] The collapse boolean is local-data ([L24]); provider wrapper keeps stable mount
      identity across collapse↔expand ([L26]); compose the real chrome, no borrowed
      CSS ([L20]); external data still enters via `useChangesetAll` /
      `useOpenBindings` only ([L02]). Name [L02]/[L11]/[L20]/[L24]/[L26] in the
      commit.
- [ ] A user's collapse survives snapshot recomputes (set keyed by entry id; ids are
      stable across snapshots).
- [ ] **Preserve the eager-fetch-gated-to-open invariant.** A collapsed entry block
      must NOT mount `EntryBody` — `BlockChrome`'s collapse-by-unmount gives this for
      free, exactly as `TugAccordion` did (Radix unmounted collapsed content). This is
      load-bearing: `EntryBody` fires `ensureRequested()` on mount (see the comment at
      the top of `EntryBody`), so the per-entry `git diff` cost stays "one per OPEN
      entry, not per row." Do NOT convert to a keep-mounted-and-hide pattern — that
      would fire a diff for every entry in the snapshot.
- [ ] Empty state, alert sheet (`useTugSheet` + `presentNotice`), and
      `sweepEntryDiffStores` effect unchanged.
- [ ] Dash entries: `DashActions` renders in the body and every step-21 affordance
      (`changeset-dash-join`, `-preview-clean`, `-preview-conflicts`, `-confirm-join`,
      `-release`, `-resolve`) is present and functional post-swap ([P06]).
- [ ] No stray `TugAccordion` / `TugListView` / `TugListRow` imports remain in
      `changeset-card.tsx`.

**Tests:**
- [ ] `just app-test at0228-changeset-aggregate.test.ts` (adapted per [Q02]).
- [ ] `just app-test at0229-changeset-dash-join.test.ts` — expected to pass with
      **no selector changes** (all its selectors are body-scoped under
      `changeset-entry`, and the entry block keeps its body mounted while open); a
      failure here means the swap dropped body content or changed open-once defaults.
- [ ] Existing bun suites green (no store changes expected).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test` (curated sweep)
- [ ] Manual: entries render as blocks with correct header slots; collapse/expand
      per-entry and via the toolbar; open-once holds; commit + draft + diff flows
      from M03B work inside the new structure.

---

#### Step 3: Sticky pin-stack wayfinding {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): sticky entry headers with telescoping file-block pin stack`

**References:** [P03] Pin stack, Risk R01, (#pin-stack-contract)

**Artifacts:**
- `changeset-card.css`: the `.changeset-entry-block` clearance-capture pair from
  [P03] (intermediate `--changeset-entry-pin-clearance` var; republish onto
  `> [data-slot="tool-block-body"]`).
- If Risk R01 manifests: an opaque background rule on the card-scoped stuck header
  (`.changeset-entry-block > [data-slot="tool-call-header"]` or the class the chrome
  exposes), appearance-only, no shared-chrome edits.

**Tasks:**
- [ ] Entry headers stick at the top of `.changeset-scroll`; expanded file-block
      headers stack below the stuck entry header (two visible pinned lines when
      scrolled inside an expanded file diff) — the agent-transcript telescoping
      behavior, one host over ([L06] appearance-only; no JS).
- [ ] Nothing bleeds through stuck headers on any shipped theme (spot-check one dark,
      one light).
- [ ] at0228's diff-reveal assertions still clear stuck headers (sticky-header reveal
      gotcha) — adjust scroll offsets in the test only if the new entry-level pin
      changes clearance math.

**Tests:**
- [ ] `just app-test at0228-changeset-aggregate.test.ts`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test`
- [ ] Manual scroll pass per the Tasks.

---

#### Step 4: Integration checkpoint {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every Success Criteria bullet against the live app and the test runs.
- [ ] Grep gates: no T01 module referenced at the old path; no
      `TugAccordion`/`TugListView`/`changeset-toc` in `changeset-card.tsx`.

**Tests:**
- [ ] Full aggregate run.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The block grammar lives at a neutral `tugways/blocks/` home, and the
Changeset card is a single scroll of sticky-headed `BlockChrome` entry sections —
structurally ready to be lifted into the Lens card as its first section, with zero
loss of M03B content quality or M04 dash function.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Table T01 modules at the new home; old-path grep clean (#step-1 checkpoint).
- [ ] Entries are collapse-provider-wrapped `BlockChrome`s; accordion, TOC, and
      reveal logic deleted; open-once + toolbar semantics preserved (#step-2).
- [ ] Two-level sticky telescoping works inside `.changeset-scroll` on shipped
      themes (#step-3).
- [ ] M04 dash affordances fully functional in the new structure
      (`at0229-changeset-dash-join.test.ts` green, no selector changes).
- [ ] `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `just app-test` all green.

**Acceptance tests:**
- [ ] Adapted `tests/app-test/at0228-changeset-aggregate.test.ts`
- [ ] `tests/app-test/at0229-changeset-dash-join.test.ts`, re-run unmodified in flow

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The Lens plan (M3): Lens card host (`TugListView(inline)` spine, `scrollKey`),
      lens section registry + contract (reserved `findSegments` / `followBottom` /
      `responderNeeds` hooks), `ChangesetSection` packaging of this card's guts, the
      Hello World card repurposed as the second registrant, clean-break retirement of
      the standalone Changeset card, singleton-vs-instantiable decision.
- [ ] `types.ts` layer-contract split, if the Lens section contract wants it ([Q01]).
- [ ] QuestionDialog textareas onto `TugMessageEditor`.

| Checkpoint | Verification |
|------------|--------------|
| Re-home complete, zero drift | old-path grep clean; curated `just app-test` unchanged |
| Structure converted | no accordion/TOC symbols in the card; adapted at0228 green |
| Wayfinding | manual two-level sticky pass + reveal assertions |
| Build health | `bun test`, `bunx vite build`, `bunx tsc --noEmit`, `just app-test` |
