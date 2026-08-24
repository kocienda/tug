<!-- devise-skeleton v4 -->

## Unify the Lens on the Block Family {#lens-block-unification}

**Purpose:** Collapse the Lens section accordions and the transcript tool-call header onto **one Block header primitive with a three-tier altitude scale**, so every surface in the Lens (section bands, session-entry cards, file rows) and the transcript reads as one component family — with grip-drag sections that carry full drag-and-drop visuals, right-aligned section controls, and session tags folded into entry titles.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-16 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Lens is a vertical stack of reorderable, collapsible sections (Telemetry, Log, Sessions, Git History). Today each section is rendered by `LensSection` in `tugdeck/src/components/lens/lens-section-band.tsx` — a **one-off** sticky "band" (`.lens-section-band` CSS) with its own `GripVertical` handle, a `TugIconButton` single-chevron, and no relationship to the transcript's mature tool-call header (`BlockHeader` + `BlockChrome` in `tugdeck/src/components/tugways/blocks/`). The two look-alike header systems have drifted into parallel implementations. The section band is oversized (font-weight 600 at `font: var(--tug-font-ui)`, `padding: 8px 10px`), its Expand-all / Collapse-all controls sit in a `.sessions-toolbar` *below* the header (badly positioned), its drag-reorder (`LensContent.onGripPointerDown`) is a bare DOM flex-`order` swap with **no ghost, no drop caret, no animation**, and session rows fall back to raw 8-char UUID hashes (`d665249e`) instead of the mnemonic adjective-noun tags that shipped in the `session-tags` work.

The fix is a single Block header primitive shared by all altitudes. The transcript's `BlockChrome` already frames the session-*entry* cards inside the Sessions section, so the frame is half-adopted; this plan finishes the job by extracting the header shell every altitude wears, rebuilding the section band on it, and adding the drag visuals and tag adoption the user specified.

#### Strategy {#strategy}

- **Phase 1 (M01) is a pure no-visual-change extraction.** Pull the header layout shell out of `BlockHeader` into a new `BlockStrip` primitive that renders the *identical* DOM (same class names, same `data-slot`s) via slot props. `BlockHeader` becomes a thin composition filling those slots. Nothing on screen changes; existing CSS and tests keep matching by construction.
- **Phase 2 (M02)** rebuilds `LensSection` on `BlockStrip` at `altitude="section"`, moves Expand-all / Collapse-all into a real right-aligned actions cluster, and deletes the `.lens-section-band` / `.sessions-toolbar` one-offs.
- **Phase 3 (M03)** scales the session-entry cards to `altitude="entry"` and folds the session tag into entry titles (name → tag → id-hash).
- **Phase 4 (M04)** replaces the bare reorder with hand-rolled FLIP visuals: ghost the dragged section, close up the vacated gap, show a drop caret, settle into place — all DOM/CSS, no React state mid-drag.
- Altitude is expressed as a **token scale** keyed on a `data-altitude` attribute, resolving `--tug*` in one hop ([L17]); the shared component owns the structure, per-altitude CSS owns the sizes.
- Each phase is independently shippable and ends with an integration checkpoint. The refactor is regression-first: Phase 1 proves the extraction is inert before any altitude divergence.

#### Milestones {#milestones}

The four phases are the plan's milestones; each maps to a step group closed by an integration checkpoint.

**Milestone M01: Extraction (no visual change)** {#m01-extraction} — #step-1 (and the inert token scaffold in #step-2).

**Milestone M02: Sections as blocks** {#m02-sections-as-blocks} — #step-3, #step-4, closed by #step-5.

**Milestone M03: Entry altitude + tag fold** {#m03-entry-tag} — #step-6, #step-7, closed by #step-8.

**Milestone M04: FLIP drag visuals** {#m04-flip-drag} — #step-9, closed by #step-10.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- After Phase 1, the transcript renders byte-identically: `.tool-call-header` DOM (class names + `data-slot="tool-call-header"`, `tool-call-header-{leading,name,detail,summary,timing,actions}`) is unchanged, `cd tugdeck && bunx vite build` succeeds, and all existing block tests pass. (Verify: diff the rendered header DOM in a gallery/app-test screenshot against pre-change.)
- The Lens section band and the transcript tool header both render through `BlockStrip` — no component imports `lens-section-band.tsx` after Phase 2 (it is deleted). (Verify: `grep -r lens-section-band tugdeck/src` returns only the renamed/relocated file, if any.)
- Expand-all / Collapse-all live in the Sessions section header's right-aligned actions cluster; the `.sessions-toolbar` / `.sessions-head` markup is gone. (Verify: `grep -rn "sessions-toolbar\|sessions-head" tugdeck/src` returns nothing; `data-testid="sessions-expand-all"` resolves inside the section band in an app-test.)
- A session with no custom name renders its adjective-noun tag (not the 8-char hash) in the entry title. (Verify: unit test on the new `sessionEntryTitle` helper; app-test/screenshot on a real session.)
- Dragging a section shows a ghost of the dragged band, closes the vacated gap, renders a drop caret at the target slot, and animates the band into place on drop; the committed order matches `lensStore.getSnapshot().sectionOrder`. (Verify: app-test drives a grip pointer-drag with settle delays and asserts the post-drop store order + the presence of `.block-drop-caret` mid-drag.)
- No new dependency is added; drag visuals are CSS transitions + FLIP measurement only. (Verify: `git diff package.json` is empty.)

#### Scope {#scope}

1. Extract `BlockStrip` (the shared header shell) and refactor `BlockHeader` onto it with zero visual change (Phase 1).
2. Add a three-tier `altitude` token scale (`leaf` / `entry` / `section`) consumed by `BlockStrip` and threaded through `BlockChrome`.
3. Rebuild `LensSection` on `BlockStrip` at `altitude="section"`, add `BlockGrip`, and move the section chevron to `BlockFoldCue` (Phase 2).
4. Add an optional `headerActions` factory to `LensSectionDefinition`; move Sessions Expand-all / Collapse-all into the section header via a shared `sessionsEntryCollapseStore` (Phase 2).
5. Scale session-entry cards to `altitude="entry"` and fold the session tag into entry titles (Phase 3).
6. Replace the reorder preview with FLIP-based drag visuals (`useBlockReorder` + `BlockDropCaret`) (Phase 4).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Reordering *entries* (session cards) within a section — only sections reorder.
- Changing the collapse *mechanism*: sections keep lensStore-driven collapse; entries/tool-calls keep `ToolBlockCollapseContext`. Only the header *appearance* unifies.
- Moving the session-tag precedence server-side into the changeset feed (`SessionChangesetEntry.display_name`). Phase 3 resolves the tag client-side from `sessionTagStore`; a server-side move is a noted follow-on ([R02]).
- Touching the `note` / `data` block variants (Thinking, markdown-table) that render on their own roots rather than through `BlockHeader`.
- Windowing / height-estimate changes — sections stay inline at real measured heights ([no height estimates law]).

#### Dependencies / Prerequisites {#dependencies}

- Session tags already shipped: `sessionTagStore.getTag(tugSessionId)` (`tugdeck/src/lib/session-tag-store.ts`) and the precedence helpers in `tugdeck/src/lib/session-name.ts`.
- The Block system: `BlockHeader`/`BlockChrome`/`BlockFoldCue`/`BlockCopyButton`/`BlockActionsCluster` (`tugdeck/src/components/tugways/blocks/` and `.../body-kinds/affordances/`).
- The Lens store (`tugdeck/src/lib/lens-store/`), registry (`tugdeck/src/components/lens/lens-section-registry.ts`), and `LensContent` DnD host.

#### Constraints {#constraints}

- **Tuglaws.** [L01] one `root.render`; [L02] external state via `useSyncExternalStore`; [L03] registrations in `useLayoutEffect`; [L06] appearance via CSS/DOM attributes, never React state; [L08] DOM-only drag preview committed to the store on drop; [L17] `--tugx-*` resolves to `--tug*` in one hop; [L19] `.tsx`+`.css` pairs with docstring + `data-slot`; [L20] component-token sovereignty; [L22] FocusManager group order driven off the store; [L24] local data via store/useState+useRef; [L26] stable mount identity across collapse.
- **Warnings are errors** in the Rust workspace, but this plan is tugdeck-only (no Rust). tugdeck must pass `bunx vite build` (production rollup — an import that works under dev esbuild can still fail the build).
- No `localStorage`/`sessionStorage`/IndexedDB — persistent state already goes through `lensStore` / tugbank.
- No new npm dependency; use bun, never npm.

#### Assumptions {#assumptions}

- The 8-char id-hash fallback in `display_name` is exactly `owner_id.slice(0, 8)` — confirmed at `sessions-section.tsx` line 205 (`binding.tugSessionId.slice(0, 8)`) and mirrored by the server changeset feed. This makes "no custom name" detectable by exact string equality.
- The app-test harness can synthesize pointer gestures on `[data-testid="lens-section-grip"]` with settle delays (per the app-test synthetic-gesture guidance). Section reorder is app-testable even though the Sessions body's changeset entries are transient (~2s) — the section *bands* (Telemetry/Log/Sessions/Git History) are always present regardless of changeset content.
- Building and running Tug.app is cheap; visual phases (2–4) are verified by `just run` + screenshot in addition to `just app-test`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. Anchors are kebab-case, no phase numbers. Plan-local decisions are `[P01]`+ (never `[D01]`, reserved for the global `design-decisions.md`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Section header: full `BlockChrome` or shared `BlockStrip`? (DECIDED) {#q01-section-chrome-vs-strip}

**Question:** Should a Lens section render as a full `BlockChrome altitude="section"` (frame + header + collapse-by-unmount), or compose only the shared header shell `BlockStrip` while keeping its existing lensStore-driven collapse and body?

**Why it matters:** `BlockChrome` owns collapse via `ToolBlockCollapseContext` and writes `--tugx-block-header-height` for inner telescoping; the section already owns collapse via `lensStore.setCollapsed` and writes `--tugx-pin-stack-top` = measured band height on the section root (for nested sticky content). Making a section a full `BlockChrome` means bridging two collapse owners and reconciling two sticky-offset variables — fighting the frame rather than reusing it.

**Options:**
- Full `BlockChrome` with a lensStore-backed `ToolBlockCollapseContext` handle.
- `BlockStrip` shell only; section retains lensStore collapse, body rendering, and pin measurement.

**Resolution:** DECIDED (see [P02]) — sections compose `BlockStrip`. The unified family lives at the **header-shell** level, which is the visible thing; entries and tool calls compose full `BlockChrome` (which itself renders `BlockStrip`). One header primitive, three altitudes, without cross-wiring two collapse mechanisms.

#### [Q02] Sharing the Sessions bulk-collapse state with the section header (DECIDED) {#q02-bulk-collapse-state}

**Question:** Expand-all / Collapse-all operate on `SessionsSectionBody`'s local `collapsedEntries` `useState`. The section header (rendered by `LensSection`, a *sibling* of the body via separate registry factories) can't reach that state directly. How do the header actions drive it?

**Why it matters:** `LensSection` renders `def.body(host)` and (new) `def.headerActions(host)` as independent React subtrees; they share only `host`. Bulk actions in the header must mutate the same per-entry collapse state the body reads.

**Options:**
- Lift per-entry collapse into a module store keyed by entry id, read by both subtrees via `useSyncExternalStore` ([L02]/[L24]).
- Thread a callback bus through `host`.

**Resolution:** DECIDED (see [P05]) — introduce `sessionsEntryCollapseStore` (`tugdeck/src/lib/sessions-entry-collapse-store.ts`), a module singleton keyed by entry id. Both the body (per-entry collapsed read) and the header actions (bulk set) subscribe. This is the honest [L02] mechanism and preserves open-once semantics (an id absent from the collapsed set is open).

#### [Q03] Tag precedence data path for entry titles (DECIDED) {#q03-tag-precedence-path}

**Question:** `SessionChangesetEntry.display_name` is already `"name when user-set, else id hash"` and carries no `tag`. How does the entry title become name → tag → hash?

**Why it matters:** The tag lives client-side in `sessionTagStore` (and the tugcast ledger), not in the changeset feed. Getting precedence right without a server change means detecting the "no name" case client-side.

**Resolution:** DECIDED (see [P07]) — resolve client-side. `EntryIdentity` subscribes to `sessionTagStore.getTag(owner_id)`; a pure helper `sessionEntryTitle(displayName, ownerId, tag)` returns `tag ?? displayName` when `displayName === ownerId.slice(0, 8)` (the exact id-hash fallback ⇒ no custom name), else `displayName`. Mirrors how `SessionIdBadge` already reads the tag store client-side. Server-side consolidation is deferred ([R02]).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Phase 1 extraction drifts the header visually | high | med | Keep identical class names + `data-slot`s; no CSS edits in Phase 1; screenshot-diff | Any header pixel changes |
| FLIP drag jank / dropped pointer capture | med | med | Pointer capture on the grip; `transition` cleared on `transitionend`; abort on Escape | Visible stutter or stuck ghost |
| Section = `BlockStrip` breaks the sticky pin stack | med | low | Preserve the section root's `--tugx-pin-stack-top` ResizeObserver verbatim | Nested sticky content slips under the band |
| Tag hash-equality heuristic misfires | low | low | Exact-string equality against `owner_id.slice(0,8)`; unit-tested | A non-hash display_name equals its own hash prefix (not possible for real names) |

**Risk R01: Phase 1 is not actually inert** {#r01-phase1-drift}

- **Risk:** Extracting `BlockStrip` subtly changes the tool-call header DOM/CSS.
- **Mitigation:** `BlockStrip` in Phase 1 emits the *same* class names and `data-slot`s; block-header.css is untouched; verify with a gallery screenshot diff and the existing block test suite.
- **Residual risk:** None expected if the DOM is byte-identical.

**Risk R02: Tag precedence lives client-side, not in the feed** {#r02-tag-clientside}

- **Risk:** The Lens entry title and the server `display_name` diverge on precedence logic.
- **Mitigation:** Isolate the rule in one pure helper (`sessionEntryTitle`); document the follow-on to move name→tag→hash into the changeset feed if a second consumer appears.
- **Residual risk:** Two places know the fallback shape until consolidated.

---

### Design Decisions {#design-decisions}

#### [P01] One header shell, `BlockStrip`, is the root of the Block header family (DECIDED) {#p01-blockstrip-root}

**Decision:** Extract the header layout shell into a new `BlockStrip` primitive (`tugdeck/src/components/tugways/blocks/block-strip.tsx` + `.css`). `BlockHeader` (tool calls) and `LensSection` (Lens bands) both compose it; `BlockChrome` renders `BlockStrip` via `BlockHeader`.

**Rationale:**
- Eliminates the parallel `.lens-section-band` implementation; a change to the header shell lands everywhere at once.
- `BlockStrip` carries the slot contract (`grip? · leading · title · detail? · trailing… · actions`) and the pipe-separator / one-line-box / clamp discipline already proven in `block-header.css`.

**Implications:**
- `BlockStrip` accepts a caller-supplied `className` and `data-slot` so `BlockHeader` keeps stamping `tool-call-header` + `data-slot="tool-call-header"` (zero visual change, existing selectors/tests keep matching).
- New slot props on `BlockStrip`; `BlockHeader`'s own props interface is unchanged externally.

#### [P02] Sections compose `BlockStrip`; entries/tool-calls compose `BlockChrome` (DECIDED) {#p02-section-strip}

**Decision:** A Lens section renders its header as `BlockStrip` at `altitude="section"` and keeps its existing lensStore-driven collapse, conditional body render, and `--tugx-pin-stack-top` ResizeObserver. It does *not* become a full `BlockChrome`.

**Rationale:** See [Q01]. Avoids bridging two collapse owners and two sticky-offset variables. The visible family lives at the shell level.

**Implications:** The section chevron becomes a `BlockFoldCue` (the `ChevronsDown`/`ChevronsUp` pair) inside the actions cluster, toggling `lensStore.setCollapsed`. The `TugIconButton` single-chevron is removed.

#### [P03] Altitude is a three-tier token scale keyed on `data-altitude` (DECIDED) {#p03-altitude-scale}

**Decision:** `BlockStrip` stamps `data-altitude="leaf" | "entry" | "section"` on its root. Per-altitude CSS overrides the `--tugx-toolheader-*` (or new `--tugx-strip-*`) tokens. `leaf` reproduces today's values exactly; `entry` is `leaf` with slightly more strip padding; `section` bumps name size ~1.12×, weight to bold, and adds a touch of vertical padding — *slightly* above `leaf`, not the oversized current band.

**Rationale:** The user wants sections one level above tool headers but only slightly bigger; the current band is too big. A token scale ([L17]/[L20]) keeps the structure shared and the sizes declarative.

**Implications:** `BlockChrome` gains an `altitude?: "leaf" | "entry" | "section"` prop (default `leaf`) forwarded to `BlockHeader`→`BlockStrip`. Concrete section values: `--tugx-toolheader-name-size: calc(var(--tug-font-size-sm) * 1.12)`, `--tugx-toolheader-name-weight: var(--tug-font-weight-bold)`, strip padding `var(--tug-space-sm) var(--tug-space-md)`, line box `calc(var(--tug-font-size-sm) * 1.75)`.

#### [P04] `BlockGrip` is a shared affordance; sections populate the `grip` slot (DECIDED) {#p04-blockgrip}

**Decision:** Add `BlockGrip` (`tugdeck/src/components/tugways/body-kinds/affordances/block-grip.tsx` + `.css`), wrapping `GripVertical` with grab/grabbing cursor and `touch-action: none`, and forwarding `onPointerDown`. Only `altitude="section"` fills `BlockStrip`'s `grip` slot.

**Rationale:** The grip is a reusable Block affordance, so entry-level reordering (a future) reuses it; keeps the drag handle in the shared library, not a section one-off.

**Implications:** `BlockStrip` renders the `grip` slot leftmost (left of `leading`), collapsing out of flow when absent.

#### [P05] Per-entry Sessions collapse moves to `sessionsEntryCollapseStore` (DECIDED) {#p05-entry-collapse-store}

**Decision:** Replace `SessionsSectionBody`'s local `collapsedEntries` `useState` with a module store `sessionsEntryCollapseStore` (`tugdeck/src/lib/sessions-entry-collapse-store.ts`) keyed by entry id, exposing `subscribe`, `isCollapsed(id)`, `toggle(id, next)`, `expandAll()`, `collapseAll(seenIds)`. Both the section body and the section `headerActions` read it via `useSyncExternalStore`.

**Rationale:** See [Q02]. The header actions and body live in sibling subtrees; a store is the [L02]/[L24] bridge. Preserves open-once (absent ⇒ open) and the "collapse-all covers the whole seen set" behavior (the store keeps its own seen set).

**Implications:** The `seenSectionsRef` logic moves into the store. Test IDs `sessions-expand-all` / `sessions-collapse-all` are preserved but relocate into the section header.

#### [P06] `LensSectionDefinition` gains an optional `headerActions` factory (DECIDED) {#p06-header-actions-factory}

**Decision:** Add `headerActions?: (host: LensSectionHost) => React.ReactNode` to `LensSectionDefinition`. `LensSection` renders it in the actions cluster, LEFT of the `BlockFoldCue` chevron. Sessions supplies Expand-all / Collapse-all; Telemetry/Log/Git History supply none (chevron only).

**Rationale:** Keeps `LensSection` generic while letting a section contribute its own right-aligned controls — the registry-driven equivalent of the transcript's body-kind actions portal.

**Implications:** The actions cluster mirrors `.tool-call-header-actions` (section `headerActions` sit where the body-kind portal sits, chevron rightmost).

#### [P07] Session tag folds into entry title via a pure client-side helper (DECIDED) {#p07-tag-fold}

**Decision:** Add `sessionEntryTitle(displayName: string, ownerId: string, tag: string | null): string` to `tugdeck/src/lib/session-name.ts`, returning `tag ?? displayName` when `displayName === ownerId.slice(0, 8)`, else `displayName`. `EntryIdentity` subscribes to `sessionTagStore` for the session item's `owner_id` and renders `sessionEntryTitle(...)`.

**Rationale:** See [Q03]. Name → tag → hash precedence without a server change; one testable pure helper.

**Implications:** `EntryIdentity` (currently pure, taking only `item`) becomes a subscriber for session items; dash/unattributed items are unaffected (no tag path).

#### [P08] Drag visuals are hand-rolled FLIP + CSS; commit on drop only (DECIDED) {#p08-flip-drag}

**Decision:** Replace `LensContent.onGripPointerDown`'s bare `order` swap with a `useBlockReorder` hook (`tugdeck/src/components/lens/block-reorder.ts`) + `BlockDropCaret` (`tugdeck/src/components/lens/block-drop-caret.tsx` + `.css`) that: ghosts the dragged section (`data-dragging` → opacity/scale, `pointer-events: none`), FLIP-animates siblings to close the vacated gap and open the target slot, renders a single positioned drop caret at the target index, and FLIPs the dragged band into its landed slot on `pointerup`, committing `lensStore.setSectionOrder` only on drop.

**Rationale:** The user chose hand-rolled FLIP over a library. All appearance flows through DOM attributes + inline transforms + CSS transitions ([L06]/[L08]); no React re-render mid-drag; no new dependency.

**Implications:** Mid-drag state is inline `transform`/`data-*`; the store commit and FocusManager `setGroupOrder` re-sync remain drop-time only (unchanged from today's [L22] contract).

#### [P09] Section-altitude strip pins at `top: 0`; band height publishes on the section body (DECIDED) {#p09-pin-stack}

**Decision:** The section-altitude strip pins with an explicit `top: 0` (a `[data-altitude="section"]` override of the leaf strip's `top: var(--tugx-pin-stack-top, 0)`), and the measured band height is written as `--tugx-pin-stack-top` onto the section **body** element (`.lens-section-body`), not the section root the strip reads from.

**Rationale:**
- `BlockStrip` inherits leaf `block-header.css` where `.tool-call-header` pins at `top: var(--tugx-pin-stack-top, 0)`. Today the band pins at a literal `top: 0` while the section *root* publishes `--tugx-pin-stack-top` = measured band height for nested content — and `lens-section-band.css` explicitly warns that folding the variable onto one element is a dependency cycle.
- Rebuilding the band on the strip without this override makes the strip **read the very variable its own measured height writes on an ancestor**: the band would pin ~40px low and creep as the ResizeObserver fires. This decision breaks that self-reference by making the section band always the outermost pin (`top: 0`) and moving the producer (measured height) onto the body, whose nested sticky content inherits it cleanly.

**Implications:** The `ResizeObserver` in `LensSection` writes `--tugx-pin-stack-top` on `bodyRef` (the `.lens-section-body` element) instead of the section root; a collapsed section (no body) publishes nothing, which is correct (no nested content to clear). The static first-frame CSS fallback moves with it. The no-synchronous-seed O(n²) discipline (#header-dom-seam) is preserved verbatim.

---

### Deep Dives (Optional) {#deep-dives}

#### Current header DOM and the extraction seam {#header-dom-seam}

`BlockHeader` (`tugdeck/src/components/tugways/blocks/block-header.tsx`) renders:

```
<div data-slot="tool-call-header" data-phase data-collapsed class="tool-call-header">
  <span class="tool-call-header-leading"> | <TugProgressIndicator class="tool-call-header-dot">
  <span class="tool-call-header-name">{toolName}</span>?
  <span class="tool-call-header-detail">{target}</span>
  <span class="tool-call-header-summary">…</span>?
  <HeaderTiming/>                         // <span class="tool-call-header-timing">
  <SessionCautionBadge/>?
  <span class="tool-call-header-actions">
    <div class="tool-call-header-actions-slot" data-slot="tool-block-actions">{actions}</div>?
    <BlockCopyButton data-slot="tool-call-header-copy"/>?
    <BlockFoldCue data-slot="tool-call-header-disclosure"/>?
  </span>
</div>
```

`BlockStrip` takes these as slots: `root` props (`className`, `dataSlot`, `data-*`), `grip?`, `leading` (the dot-or-glyph span), `name?`, `detail`, `trailing` (an array/fragment of pipe-sections: summary, timing, caution), and `actions` (the actions cluster contents). In Phase 1, `BlockHeader` passes the *exact same* nodes and classes, so the emitted DOM is identical. The pipe-separator CSS keys on the trailing section classes (`.tool-call-header-summary`, `.tool-call-header-timing`, `.tool-call-header-actions`) — `BlockStrip` must render those class names for leaf so `block-header.css` keeps matching untouched.

**Gotcha — O(n²) measurement discipline.** Both `BlockChrome` and `LensSection` deliberately avoid a synchronous `getBoundingClientRect`/`offsetHeight` seed in their mount `useLayoutEffect` (a dev session mounts 2000+ blocks; a forced read per block reflows the growing document → O(n²), the dominant cost of a ~14s mount). They rely on the `ResizeObserver`'s initial `observe()` callback (rAF-coalesced) with a static CSS first-frame fallback. Any measurement `BlockStrip` or the section adds MUST keep this discipline — no synchronous seed.

#### FLIP interaction spec {#flip-spec}

**Spec S01: Section drag lifecycle** {#s01-drag-lifecycle}

Given the visible section elements (`.lens-section[data-lens-section]`) inside `.lens-sections`:

1. **pointerdown on grip** → `event.preventDefault()`; capture the pointer; snapshot the visible order and each element's `getBoundingClientRect()` top. Set `data-dragging="true"` on the dragged section (CSS: opacity ~0.6, faint `scale(0.99)`, `pointer-events: none`, raised `z-index`). Record the pointer's offset within the band.
2. **pointermove (window)** → translate the dragged band to follow the pointer via inline `transform: translateY(...)`. Compute the target index from sibling midpoints (as today). Render `<BlockDropCaret>` — a thin accent hairline (`--tug` accent token, ~2px) — positioned in the gap at the target index. FLIP the non-dragged siblings to open the target slot / close the vacated gap: measure their new rects, apply the inverse `transform`, then transition to `transform: none` (CSS `transition: transform 140ms ease`).
3. **pointerup** → remove listeners; commit: if `targetIndex !== dragIndex`, `lensStore.setSectionOrder([...newVisible, ...hiddenTail])` (preserving hidden kinds after the visible order, as today). FLIP the dragged band from its floating transform into its landed slot (transition to `transform: none`), then clear all inline styles + `data-dragging` on `transitionend`. Remove the drop caret.
4. **Escape mid-drag** → abort: clear inline styles + `data-dragging` + caret, do not commit (the content-local `CANCEL_DIALOG` responder must not swallow this — keep the abort local to the drag handler).

Timings: 120–160ms ease for close-up/settle; the ghost is instantaneous. All state is DOM/inline; the only store write is the drop commit ([L06]/[L08]).

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Altitude token scale (`data-altitude`) | appearance | CSS `[data-altitude]` overrides of `--tugx-toolheader-*` | [L06], [L17], [L20] |
| Drag ghost / sibling shift / settle | appearance | inline `transform` + `data-dragging` + CSS transitions (FLIP) | [L06], [L08] |
| Drop caret element (position + visibility) | appearance/structure | positioned DOM node created/removed by the drag handler | [L06] |
| Committed section order | structure | `lensStore.setSectionOrder` on drop; read via `useSyncExternalStore` | [L02], [L08] |
| Section collapse | local-data/structure | `lensStore.setCollapsed` + `useSyncExternalStore` | [L02] |
| Per-entry Sessions collapse (`sessionsEntryCollapseStore`) | local-data | module store + `useSyncExternalStore` | [L02], [L24] |
| Session tag in entry title | external state | `sessionTagStore` via `useSyncExternalStore` | [L02] |
| FocusManager group order | structure | `contextFor(cardId).setGroupOrder(...)` off the store | [L22] |
| Section band height → `--tugx-pin-stack-top` (written on `.lens-section-body`, [P09]) | appearance | `ResizeObserver` + DOM var write in `useLayoutEffect` (no sync seed) | [L03], [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/blocks/block-strip.tsx` | The shared header shell primitive (slots + `data-altitude`). |
| `tugdeck/src/components/tugways/blocks/block-strip.css` | Strip layout + the altitude token scale. |
| `tugdeck/src/components/tugways/body-kinds/affordances/block-grip.tsx` | `BlockGrip` drag-handle affordance. |
| `tugdeck/src/components/tugways/body-kinds/affordances/block-grip.css` | Grip styling (grab cursor, `touch-action: none`). |
| `tugdeck/src/lib/sessions-entry-collapse-store.ts` | Module store for per-entry Sessions collapse (bulk + per-id). |
| `tugdeck/src/components/lens/block-reorder.ts` | `useBlockReorder` — FLIP drag lifecycle for sections. |
| `tugdeck/src/components/lens/block-drop-caret.tsx` | `BlockDropCaret` positioned drop indicator. |
| `tugdeck/src/components/lens/block-drop-caret.css` | Drop-caret appearance. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `BlockStrip` | component | `blocks/block-strip.tsx` | New shell; slot props + `altitude` + `className`/`dataSlot`. |
| `BlockHeader` | component | `blocks/block-header.tsx` | Refactor to compose `BlockStrip` at `altitude="leaf"`; identical DOM. |
| `BlockChrome` | component | `blocks/block-chrome.tsx` | Add `altitude?: "leaf"\|"entry"\|"section"` (default `leaf`), forward to `BlockHeader`. |
| `BlockGrip` | component | `affordances/block-grip.tsx` | Wraps `GripVertical`; `onPointerDown` forwarded. |
| `LensSection` | component | `lens/lens-section-band.tsx` → rebuilt | Compose `BlockStrip` at `altitude="section"`; grip + glyph + title + summary + actions (headerActions + `BlockFoldCue`). |
| `LensSectionDefinition.headerActions` | field | `lens/lens-section-registry.ts` | Optional `(host) => ReactNode`. |
| `sessionsEntryCollapseStore` | store | `lib/sessions-entry-collapse-store.ts` | `subscribe`/`isCollapsed`/`toggle`/`expandAll`/`collapseAll`. |
| `sessionEntryTitle` | fn | `lib/session-name.ts` | `(displayName, ownerId, tag) => string`; name → tag → hash. |
| `EntryIdentity` | component | `lens/sections/sessions-section.tsx` | Render `SessionEntryTitle` for session items; raw `itemTitle` for dash/unattributed. |
| `SessionEntryTitle` | component | `lens/sections/sessions-section.tsx` | New child; unconditionally subscribes to `sessionTagStore`; renders `sessionEntryTitle` ([L02] hook-safe). |
| `SessionsEntryBlock` | component | `lens/sections/sessions-section.tsx` | Pass `altitude="entry"` to `BlockChrome`. |
| `registerSessionsSection` | fn | `lens/sections/sessions-section.tsx` | Supply `headerActions` (Expand/Collapse-all). |
| `useBlockReorder` | hook | `lens/block-reorder.ts` | FLIP drag; replaces inline `onGripPointerDown`. |
| `BlockDropCaret` | component | `lens/block-drop-caret.tsx` | Drop indicator. |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure helpers (`sessionEntryTitle`, store reducers) | `session-name.test.ts`, a `sessions-entry-collapse-store.test.ts` |
| **Integration (app-test)** | Real Lens rendering + gestures | Section reorder gesture, controls relocated, tag on a real session |
| **Drift / screenshot** | No-visual-change proof (Phase 1) + visual phases | Gallery/app screenshot before vs after |

#### What stays out of tests {#test-non-goals}

- No fake-DOM (jsdom) render assertions and no mock-store assertion tests — banned patterns; drive the real Lens in app-test instead.
- The Sessions body's changeset *entries* are transient (~2s replay workspace), so long entry-level flows aren't app-testable; cover entry-title tag precedence via the pure `sessionEntryTitle` unit test plus a real-session screenshot, not a synthetic changeset fixture.
- FLIP timing/easing is not unit-tested (brittle); verify by app-test gesture (post-drop store order + caret presence) and by eye via `just run`.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. References are mandatory. Each phase (M01–M04) closes with an integration checkpoint.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extract `BlockStrip`; refactor `BlockHeader` (no visual change) | done | cc68a2064 |
| #step-2 | Add altitude token scale + `BlockChrome.altitude` | done | 1a3f9daef |
| #step-3 | `BlockGrip` + rebuild `LensSection` on `BlockStrip` at section altitude | done | c6e5bb61e |
| #step-4 | `headerActions` factory + relocate Sessions Expand/Collapse-all | done | fc5d0d002 |
| #step-5 | Phase 2 integration checkpoint | done | N/A (verification: vite build + 4391 unit + 83/83 app-test) |
| #step-6 | Session-entry cards → `altitude="entry"` | done | bc5cbb38a |
| #step-7 | Fold session tag into entry titles | done | fed2c18f9 |
| #step-8 | Phase 3 integration checkpoint | done | N/A (verification: vite build + 4395 unit + at0228 app-test) |
| #step-9 | FLIP drag: ghost + close-up + drop caret + settle | done | 5545c559e |
| #step-10 | Phase 4 integration checkpoint + phase exit | done | N/A (verification: package.json unchanged + vite build + 4395 unit + 83/83 app-test) |

---

#### Step 1: Extract `BlockStrip`; refactor `BlockHeader` (no visual change) {#step-1}

**Commit:** `blocks(strip): extract BlockStrip header shell from BlockHeader`

**References:** [P01] BlockStrip root, Spec — (#header-dom-seam, #context, #strategy). Laws [L06], [L19], [L20].

**Artifacts:**
- New `blocks/block-strip.tsx` + `block-strip.css`.
- `blocks/block-header.tsx` refactored to compose `BlockStrip`.

**Tasks:**
- [ ] Create `BlockStrip` with slot props: `grip?`, `leading`, `name?`, `detail`, `trailing?` (pipe-sections), `actions?`, plus root `className`, `dataSlot`, and pass-through `data-*` (`data-phase`, `data-collapsed`). Render the SAME element structure and class names as today's `BlockHeader` (`tool-call-header`, `tool-call-header-{leading,name,detail,summary,timing,actions,actions-slot}`).
- [ ] Give `BlockStrip` an `altitude` prop (default `"leaf"`) that stamps `data-altitude`; for Phase 1 leave all leaf CSS in `block-header.css` untouched so nothing changes.
- [ ] Refactor `BlockHeader` to render `BlockStrip`, passing the dot-or-`leading` span, the name span, the `detail`, the summary/timing/caution as `trailing`, and the actions cluster (`actions-slot` + Copy + FoldCue) as `actions`. Keep `data-slot="tool-call-header"` and the forwarded `ref` on the strip root (the chrome's `ResizeObserver` measures it).
- [ ] Do NOT edit `block-header.css` or any body-kind CSS in this step.
- [ ] Preserve `block-strip.css` as an (initially near-empty) pair holding only the `data-altitude` scaffolding comment ([L19] file pair).

**Tests:**
- [ ] Existing block/header tests pass unchanged (they key on `.tool-call-header*` and `data-slot`s).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds (production rollup).
- [ ] `cd tugdeck && bun test` — existing block tests green.
- [ ] `grep -rn "tool-call-header-" tugdeck/src/components/tugways/blocks/block-strip.tsx` shows the same class names (DOM parity).
- [ ] Screenshot a transcript with tool blocks via `just run`; the header is visually identical to `main`.

---

#### Step 2: Add altitude token scale + `BlockChrome.altitude` {#step-2}

**Depends on:** #step-1

**Commit:** `blocks(strip): three-tier altitude token scale`

**References:** [P03] altitude scale, (#state-zone-mapping). Laws [L06], [L17], [L20].

**Artifacts:**
- `block-strip.css` altitude token overrides.
- `blocks/block-chrome.tsx` gains `altitude`.

**Tasks:**
- [ ] In `block-strip.css`, define `[data-altitude="entry"]` and `[data-altitude="section"]` overrides of the header token family (`--tugx-toolheader-name-size`, `--tugx-toolheader-name-weight`, `--tugx-block-strip-padding` or a strip-local padding token, `--tugx-toolheader-line`). `leaf` inherits today's `block-header.css` values (no override). Section values per [P03]: name size `calc(var(--tug-font-size-sm) * 1.12)`, weight `bold`, padding `var(--tug-space-sm) var(--tug-space-md)`, line `calc(var(--tug-font-size-sm) * 1.75)`. Entry: leaf sizes with padding `var(--tug-space-sm) var(--tug-space-md)`.
- [ ] Add `altitude?: "leaf" | "entry" | "section"` (default `"leaf"`) to `BlockChromeProps`; forward through `BlockHeader` to `BlockStrip`.
- [ ] Keep leaf pixel-identical (no `data-altitude="leaf"` override rules that change values).

**Tests:**
- [ ] Build/type check green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.
- [ ] A gallery/app render at each altitude shows leaf unchanged, entry marginally roomier, section slightly larger + bold (eyeball via `just run`).

---

#### Step 3: `BlockGrip` + rebuild `LensSection` on `BlockStrip` at section altitude {#step-3}

**Depends on:** #step-2

**Commit:** `lens(section): rebuild section band on BlockStrip at section altitude`

**References:** [P01] BlockStrip root, [P02] section-strip, [P04] BlockGrip, [P09] pin-stack, (#flip-spec, #header-dom-seam, #p09-pin-stack). Laws [L02], [L03], [L06], [L17], [L19].

**Artifacts:**
- New `affordances/block-grip.tsx` + `.css`.
- `lens/lens-section-band.tsx` rebuilt on `BlockStrip`; old `.lens-section-band` header CSS removed.

**Tasks:**
- [ ] Create `BlockGrip` wrapping `GripVertical` (size 14) with `data-testid="lens-section-grip"` support, grab/grabbing cursor, `touch-action: none`, forwarding `onPointerDown`.
- [ ] Rebuild `LensSection` to render `BlockStrip altitude="section"` with: `grip` = `BlockGrip` (wired to `onGripPointerDown`), `leading` = `def.glyph`, `name` = `def.title`, `detail`/`trailing` = the live `collapsedSummary` when collapsed (else a spacer), `actions` = `[def.headerActions?.(host)] + <BlockFoldCue collapsed={collapsed} onToggle={toggle}…>`.
- [ ] Toggle collapse via `lensStore.setCollapsed(def.kind, !collapsed)` inside the `BlockFoldCue.onToggle` ([L02]).
- [ ] **Break the pin self-reference ([P09]).** `BlockStrip` inherits leaf `block-header.css`'s `.tool-call-header { top: var(--tugx-pin-stack-top, 0) }`; add a `[data-altitude="section"]` override pinning the section strip at `top: 0` (it is always the outermost pin). Move the `ResizeObserver`'s `--tugx-pin-stack-top` write from the section root onto the `.lens-section-body` element (a `bodyRef`), so the producer of the measured height is never the element the strip reads from. Keep the no-synchronous-seed discipline (#header-dom-seam); the static first-frame CSS fallback moves to `.lens-section-body`.
- [ ] Preserve the section root `<section data-lens-section data-collapsed>`. The strip is the measured band; a collapsed section (no body) writes no pin var, which is correct (nothing nested to clear).
- [ ] Preserve `data-testid="lens-section-band"` / `lens-section-body` / `lens-section-summary` so app-tests keep resolving.
- [ ] Delete the obsolete `.lens-section-band` header layout rules from `lens-section-band.css` (grip/glyph/title/summary now come from the strip); keep only section-root + body rules (the [P09] body-side pin write, border). Remove the `TugIconButton` chevron and its import.

**Tests:**
- [ ] Build green; the four sections (Telemetry, Log, Sessions, Git History) still register and render.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.
- [ ] `just app-test` — the Lens mounts; `[data-testid="lens-section-band"]` resolves for each section; collapse toggles hide/show the body.
- [ ] `just run` + scroll the Lens — each section band pins flush at the scroller top (no ~40px low-pin or creep, [P09]) and reads as a slightly-larger tool header (grip · glyph · title · summary · chevron), not the oversized old band.

---

#### Step 4: `headerActions` factory + relocate Sessions Expand/Collapse-all {#step-4}

**Depends on:** #step-3

**Commit:** `lens(sessions): move Expand/Collapse-all into the section header`

**References:** [P05] entry-collapse store, [P06] headerActions factory, [Q02]. Laws [L02], [L24].

**Artifacts:**
- New `lib/sessions-entry-collapse-store.ts`.
- `lens-section-registry.ts` gains `headerActions`.
- `sessions-section.tsx`: toolbar removed, `headerActions` supplied, body reads the store.

**Tasks:**
- [ ] Add `headerActions?: (host: LensSectionHost) => React.ReactNode` to `LensSectionDefinition`; `LensSection` renders it left of the chevron (already wired in #step-3's actions slot).
- [ ] Create `sessionsEntryCollapseStore`: `subscribe(listener)`, `isCollapsed(id): boolean`, `toggle(id, next)`, `expandAll()`, `collapseAll()`, with an internal seen-id set so `collapseAll` covers the whole seen set (mirrors the current `seenSectionsRef` behavior). Absent id ⇒ open (open-once default).
- [ ] Refactor `SessionsSectionBody` to read per-entry collapse from the store (`useSyncExternalStore`) instead of local `collapsedEntries` state; feed each `SessionsEntryBlock`'s `collapsed`/`onToggle` from the store; register each snapshot's ids as seen.
- [ ] **Intended behavior change:** per-entry collapse now persists across a section collapse/expand and a Lens close/reopen (the module store outlives the body's mount, unlike today's body-local `useState` which reset on unmount). This is desired — a user's per-entry fold should survive toggling the section. Keyed by stable entry id, so a recomputed snapshot restores each entry's fold.
- [ ] In `registerSessionsSection`, add `headerActions` returning the two `TugPushButton emphasis="ghost" role="action" size="2xs"` controls (`data-testid="sessions-expand-all"` / `sessions-collapse-all`) wired to `sessionsEntryCollapseStore.expandAll/collapseAll`.
- [ ] Delete the `.sessions-head` / `.sessions-toolbar` / `.sessions-toolbar-spacer` markup and CSS.

**Tests:**
- [ ] `sessions-entry-collapse-store.test.ts` — `collapseAll` after seeing ids collapses them; a later `toggle(id,false)` re-opens; absent id reads open.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.
- [ ] `grep -rn "sessions-toolbar\|sessions-head" tugdeck/src` returns nothing.
- [ ] `just app-test` — `sessions-expand-all` resolves inside the Sessions section band and toggles entry collapse.

---

#### Step 5: Phase 2 integration checkpoint {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P02] section-strip, [P06] headerActions, (#success-criteria).

**Tasks:**
- [ ] Verify no code imports `lens-section-band`'s old band internals; the shared `BlockStrip` powers section + tool headers.
- [ ] Verify reorder still commits `lensStore.setSectionOrder` (bare preview retained from today; FLIP lands in #step-9).

**Tests:**
- [ ] `just app-test` — reorder a section by grip; the post-drop order matches `lensStore.getSnapshot().sectionOrder`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && bun test` green.
- [ ] `just app-test` green.

---

#### Step 6: Session-entry cards → `altitude="entry"` {#step-6}

**Depends on:** #step-5

**Commit:** `lens(sessions): scale entry cards to entry altitude`

**References:** [P03] altitude scale, (#state-zone-mapping). Law [L06].

**Artifacts:**
- `sessions-section.tsx` `SessionsEntryBlock` passes `altitude="entry"`.

**Tasks:**
- [ ] Pass `altitude="entry"` to the `BlockChrome` inside `SessionsEntryBlock`. File-row `BlockChrome`s inside `EntryBody` stay `leaf` (default).
- [ ] Confirm the entry-vs-file visual step matches the screenshot hierarchy (entry title bolder/slightly larger than file rows).

**Tests:**
- [ ] Build green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.
- [ ] `just run` — entry cards read one step above their file rows, one step below the section band.

---

#### Step 7: Fold session tag into entry titles {#step-7}

**Depends on:** #step-6

**Commit:** `lens(sessions): fold session tag into entry titles`

**References:** [P07] tag fold, [Q03], (#q03-tag-precedence-path). Laws [L02].

**Artifacts:**
- `session-name.ts` gains `sessionEntryTitle`.
- `sessions-section.tsx` `EntryIdentity` subscribes to `sessionTagStore`.

**Tasks:**
- [ ] Add `sessionEntryTitle(displayName, ownerId, tag)` to `session-name.ts`: return `tag ?? displayName` when `displayName === ownerId.slice(0, 8)`, else `displayName`.
- [ ] Adopt the tag **without a conditional hook** ([L02] — hooks run unconditionally). Extract a dedicated `SessionEntryTitle` child component that `EntryIdentity` renders only for `item.kind === "session"`; that child *unconditionally* subscribes to `sessionTagStore` for the session's `owner_id` (`useSyncExternalStore`) and renders `sessionEntryTitle(displayName, ownerId, tag)`. `EntryIdentity` keeps rendering raw `itemTitle(item)` for dash/unattributed items (no tag path), so no hook is ever gated behind an `item.kind` branch inside a single component.

**Tests:**
- [ ] `session-name.test.ts` — hash display_name + tag ⇒ tag; named display_name + tag ⇒ name; no tag + hash ⇒ hash.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && bun test` green.
- [ ] `just run` — a nameless session shows its adjective-noun tag (not `d665249e`) in the entry title.

---

#### Step 8: Phase 3 integration checkpoint {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P03] altitude scale, [P07] tag fold, (#success-criteria).

**Tasks:**
- [ ] Verify the three altitudes read as one family with a clear scale (section > entry > leaf) and nameless sessions show tags.

**Tests:**
- [ ] `just app-test` green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && bun test` green; `just app-test` green.

---

#### Step 9: FLIP drag: ghost + close-up + drop caret + settle {#step-9}

**Depends on:** #step-5

**Commit:** `lens(reorder): FLIP drag visuals — ghost, drop caret, settle`

**References:** [P08] FLIP drag, Spec S01, (#flip-spec, #state-zone-mapping). Laws [L06], [L08], [L22].

**Artifacts:**
- New `lens/block-reorder.ts` (`useBlockReorder`).
- New `lens/block-drop-caret.tsx` + `.css`.
- `lens-content.tsx` uses the hook; `lens-section-band.css` drag-state rules.

**Tasks:**
- [ ] Extract the drag lifecycle from `LensContent.onGripPointerDown` into `useBlockReorder` and extend per Spec S01: ghost the dragged band (`data-dragging` CSS: opacity ~0.6, `scale(0.99)`, `pointer-events: none`, raised `z-index`), follow the pointer with inline `translateY`, FLIP siblings to open/close the slot (`transition: transform 140ms ease`), render `BlockDropCaret` at the target index, and settle the dragged band into place on drop (`transitionend` clears inline styles).
- [ ] Keep the commit drop-only: `lensStore.setSectionOrder([...newVisible, ...hiddenTail])`; keep the FocusManager `setGroupOrder` re-sync at drop ([L22]).
- [ ] Escape mid-drag aborts without committing (clear inline styles + caret); do not let the Lens `CANCEL_DIALOG` responder swallow it.
- [ ] `BlockDropCaret`: a positioned ~2px accent hairline using a `--tug` accent token; created/removed by the handler (DOM, not React state).
- [ ] **Watch-item — sticky vs. transform.** FLIP applies `translateY` to `.lens-section` roots whose bands are `position: sticky` ([P09] pins them at `top: 0`). A band that is *stuck* mid-scroll computes its sticky offset before the transform and can pop during the drag. If observed during tuning, suspend stickiness for the duration of a live drag — set the dragged/animating sections to `position: relative` while `data-dragging` (or a container `data-reordering`) is set, restoring on drop. Drags typically start from an unstuck grip, so treat this as a tuning step, not a redesign.

**Tests:**
- [ ] `just app-test` — a grip pointer-drag (with settle delays) shows `.block-drop-caret` mid-drag and lands the section; post-drop `lensStore.getSnapshot().sectionOrder` matches the new order.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.
- [ ] `just app-test` green; `just run` shows ghost + caret + settle by eye.

---

#### Step 10: Phase 4 integration checkpoint + phase exit {#step-10}

**Depends on:** #step-9

**Commit:** `N/A (verification only)`

**References:** [P08] FLIP drag, (#success-criteria, #exit-criteria).

**Tasks:**
- [ ] Verify all Success Criteria hold end-to-end.

**Tests:**
- [ ] Full `just app-test` + `cd tugdeck && bunx vite build && bun test` green.

**Checkpoint:**
- [ ] `git diff package.json` empty (no new dependency).
- [ ] `grep -rn "lens-section-band\|sessions-toolbar" tugdeck/src` returns only intended survivors.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Lens section bands, session-entry cards, and transcript tool-calls all render through one `BlockStrip` header family across three altitudes, with grip-drag sections carrying full FLIP drag visuals, section-owned right-aligned controls, and session tags folded into entry titles.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `BlockStrip` is the sole header shell; `BlockHeader` and `LensSection` both compose it (`grep` confirms no parallel band impl).
- [ ] Leaf tool headers are pixel-identical to pre-plan `main` (Phase 1 inert).
- [ ] Expand/Collapse-all live in the Sessions section header; `.sessions-toolbar`/`.sessions-head` are gone.
- [ ] Nameless sessions show adjective-noun tags in entry titles.
- [ ] Section drag shows ghost + close-up + drop caret + settle; order commits to `lensStore` on drop only.
- [ ] No new npm dependency; `bunx vite build` + `bun test` + `just app-test` all green.

**Acceptance tests:**
- [ ] `session-name.test.ts` (tag precedence) and `sessions-entry-collapse-store.test.ts` pass.
- [ ] `just app-test` reorder + controls-relocated assertions pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Move name→tag→hash precedence into the changeset feed (`SessionChangesetEntry.tag`) so `display_name` is authoritative server-side ([R02]).
- [ ] Entry-level reordering reusing `BlockGrip` + `useBlockReorder`.
- [ ] A shared `SectionBlock` convenience wrapper if a second registry-driven section family appears.

| Checkpoint | Verification |
|------------|--------------|
| Phase 1 inert | Header DOM parity + `bunx vite build` + existing block tests |
| Sections on BlockStrip | `just app-test` band testids + `just run` visual |
| Controls relocated | `grep` no `sessions-toolbar` + app-test `sessions-expand-all` in band |
| Tag adoption | `session-name.test.ts` + real-session screenshot |
| FLIP drag | app-test caret + post-drop store order |
