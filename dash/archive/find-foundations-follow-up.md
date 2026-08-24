<!-- devise-skeleton v4 -->

## Find Foundations Follow-up — Reveal Correctness, In-Flow Flash, Entry Shell, One Find Face {#find-foundations-follow-up}

**Purpose:** Fix the transcript Find reveal so the active match is always scrolled into
the truly-visible band (scroll-as-you-type, both edges), move the landing flash into the
scroll flow so it can never paint over chrome or detach from streaming content, put the
match count in a `TugBadge`, and — by extracting a shared **entry shell** component from
`TugPromptEntry` — rebuild the Text card's find bar so both find surfaces render one
identical face.

> **Follows** `dash/find-foundations.md` (all 13 steps landed on `main`). This plan
> repairs defects found in live use and replaces that plan's Text-card find bar
> presentation (its Step 12 built a `TugInput`-based strip; the user requires the Dev
> entry's exact face). The engines (store→index transcript search; CM6 document search)
> are untouched.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented |
| Target branch | main |
| Last updated | 2026-07-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Live vetting of the shipped find feature surfaced four defects:

1. **The first result is not scrolled into view.** The reveal in
   `dev-card-transcript.tsx` fires only when the numeric `activeIndex` changes. Typing
   refines the query, the first match becomes a *different* match, but the index stays
   `0` — so the reveal never re-fires and match "1 of N" sits off-screen.
2. **The active match can settle underneath the prompt entry.** The reveal does
   `scrollToIndex(row, { block: "nearest" })` plus a nudge that clears only the *top*
   sticky chrome (`--tugx-pin-stack-top`). There is no bottom-edge check: the
   virtualized list mounts overscan rows below the fold, their DOM Ranges resolve to
   viewport coordinates below the scroller — right where the prompt entry sits.
3. **The landing flash is a stray, out-of-flow box.** `.tugx-find-flash-overlay` is a
   `position: fixed` element appended to `document.body`
   (`transcript-find-highlighter.ts`). It paints over the prompt entry when the active
   match is a below-fold overscan row, is not clipped by the card, and does not track
   scroll or streaming content — so it visibly detaches.
4. **The Text card's find bar is a different UI.** It is a `TugInput` +
   `TugIconButton` strip — nothing like the Dev entry's find face (CM6 editor above a
   toolbar with the centred Z4B cluster and the outlined-↑ / filled-↓ Z5 pair). Two
   disparate find UIs are not acceptable. Additionally, the match count renders as bare
   text in both surfaces; it should be a `TugBadge`.

The Text-card fix is the reason this is a fresh plan: rather than duplicating the
prompt entry's look with copied CSS, we take a step back and extract the entry's
structural shell into a reusable tugways component that **both** `TugPromptEntry` and
the Text card's find bar compose — best possible reuse, no duplication, no rewrite.

#### Strategy {#strategy}

- Fix the reveal path first (identity-keyed reveal + both-edge visible band) — it is
  self-contained in `dev-card-transcript.tsx` and delivers the biggest felt win.
- Re-home the flash overlay inside the transcript scroller (content coordinates,
  clipped, scroll-tracking) — a small change to the highlighter + its CSS.
- Swap the shared cluster's count text for a single-line `TugBadge` — both find
  surfaces get it at once because `TugFindCluster` is already shared.
- Extract `TugEntryShell` from `TugPromptEntry`: the shell owns the structural zones
  (panel, input area, toolbar with leading / centred / trailing slots) and their layout
  CSS; the prompt entry becomes a composition over it, keeping its legacy class names
  as additional hooks so existing CSS and app-tests keep matching (see
  [P04](#p04-entry-shell)).
- Rebuild `TextCardFindBar` on the shell with the same real components the Dev entry
  mounts (`TugTextEditor`, `TugFindCluster`, `TugPushButton`) — identical face by
  construction, minus Z4A (route popup) and Z2 (status row).
- Verify with the existing app-test battery (at0085/at0204/at0215/… prove the prompt
  entry didn't drift) plus extended at0221 and a reworked at0223.

#### Success Criteria (Measurable) {#success-criteria}

- Typing a query in the Dev card's ⌕ route scrolls the first match into the visible
  band on every refinement that changes the active match (at0221 scenario asserts the
  active-match rect sits inside `[scroller top + pin stack, scroller bottom]`).
- After any find navigation, the active-match rect is never below the scroller's
  bottom edge (at0221 assertion).
- The flash overlay element is a descendant of the transcript scroller and its
  bounding rect is contained by the scroller's rect (at0221 assertion); it is
  `position: absolute` in content coordinates (CSS inspection).
- `TugFindCluster` renders the count inside a `TugBadge` (tinted / action, single-line)
  in both the Dev card and the Text card; the badge is non-interactive (it is a badge).
- The Text card's find bar renders the Dev entry's anatomy: CM6 substrate on top,
  toolbar beneath with centred Case/Word/Grep + count badge, outlined-↑ and filled-↓
  push buttons at the trailing edge; no route popup, no status row, no ✕ button
  (at0223 reworked to these selectors).
- `TugPromptEntry` is pixel- and behavior-identical after the shell extraction: the
  full app-test sweep passes (`just app-test` VERDICT PASS), `bun test`, project-local
  `tsc --noEmit`, and `vite build` all clean.

#### Scope {#scope}

1. Reveal correctness in the Dev transcript find host (identity-keyed, both edges,
   scroll-as-you-type).
2. Flash overlay re-parented into the scroller (clipped, scroll-tracking).
3. Match-count `TugBadge` in the shared `TugFindCluster`.
4. `TugEntryShell` extraction and `TugPromptEntry` refactor onto it.
5. `TextCardFindBar` rebuilt on the shell (Dev-entry face, minus Z4A/Z2).
6. App-test updates: at0221 extended, at0223 reworked; full-sweep integration check.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Engine changes: `transcript-search.ts`, `transcript-search-index.ts`,
  `dev-find-session.ts` semantics, and the CM6 document search are untouched (except
  the host's *consumption* of session snapshots).
- ⌘G / ⇧⌘G bindings inside the Text card (deferred — see [Q01](#q01-text-card-cmdg)).
- Searchability of `JsonTreeBlock` / `DiffBlock` / `AgentTranscriptBlock` (unchanged
  non-goals from `dash/find-foundations.md`).
- Find-and-replace; find in further card types.
- Refactoring `TugTextCardEditor` (the document editor) — only the find *bar* changes.

#### Dependencies / Prerequisites {#dependencies}

- `dash/find-foundations.md` fully landed on `main` (it is — commits `27078d9f9`
  through `a5216f01a`).
- tugdeck dev server (HMR) and `just app-test` harness working.

#### Constraints {#constraints}

- Tuglaws apply throughout: [L02] external state via `useSyncExternalStore`, [L06]
  appearance through CSS/DOM never React state, [L11] controls emit actions /
  responders mutate, [L20] tokens scoped to the component slot, [L22] store-driven DOM
  writes subscribe to the store directly, [L26] persistent chrome is one node.
- No `localStorage`; find options stay in tugbank via `putFindOptions` (global
  preference, one setting for every find surface — inherited decision).
- Warnings are errors; `bunx` fetches wrong global versions — use
  `tugdeck/node_modules/.bin/tsc` and `.../vite`.
- Only the user commits on `main`; `/tugplug:implement` follows its own commit policy.

#### Assumptions {#assumptions}

- The transcript scroller is the element carrying
  `data-tug-scroll-key="dev-card-transcript"`; it is the `.tug-list-view` scroll
  container, which is `position: relative` and owns `overflow-y: auto`
  (`tug-list-view.css`) — so an absolutely-positioned child in content coordinates is
  clipped and scrolls with content.
- `TugTextEditor` registers its own CUT/COPY/PASTE/SELECT_ALL responders (it is the
  responder for editing actions per its module doc), so a standalone mount in the find
  bar gets working edit keys without extra wiring.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` headings,
kebab-case anchors without phase numbers, stable two-digit labels (`[P01]`, `[Q01]`,
`R01`, `S01`, `T01`, `L01`), `**Depends on:**` lines citing `#step-N` anchors, and
rich `**References:**` lines on every step. Never cite line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] ⌘G / ⇧⌘G inside the Text card (OPEN) {#q01-text-card-cmdg}

**Question:** Should ⌘G / ⇧⌘G cycle matches while the Text card's find bar is open
(and/or after it closes), mirroring the Dev card's session-has-matches gating?

**Why it matters:** Keyboard parity between the two surfaces; but it needs a Text-card
keybinding surface the bar doesn't currently own.

**Plan to resolve:** Defer. The bar's Enter / Shift-Enter and the Z5 buttons cover
navigation; add ⌘G as a follow-on if wanted after living with the rebuilt bar.

**Resolution:** DEFERRED (follow-on; see #roadmap).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Prompt-entry regression from shell extraction | high | low | Zone elements keep legacy classes; layout CSS moves verbatim; at0050/at0085/at0103/at0104/at0204/at0215/at0216/at0221/at0222 already cover the entry | Any prompt-entry app-test fails |
| CM6 swallows Escape/Enter in the find bar | med | med | Bind via `Prec.high(keymap.of(...))` passed through `TugTextEditor`'s `extensions` prop (the prompt entry drives its query mirror through the same prop) | Escape fails to dismiss in at0223 |
| Reveal fights follow-bottom during streaming | med | med | Verify in Step 1; if programmatic `scrollTop` writes are overridden by follow-bottom, disengage follow when a reveal runs (find is what the UI favors once underway) | Reveal visibly bounces back in at0221 |

**Risk R01: Shell extraction drifts the prompt entry** {#r01-shell-drift}

- **Risk:** Moving layout CSS to new `.tug-entry-shell*` selectors changes computed
  style somewhere (specificity, ordering, `:focus-within` scoping).
- **Mitigation:** Move rules verbatim, only re-keying selectors; keep host-specific
  rules on the legacy classes, which remain on the same elements; run the prompt-entry
  app-test battery and eyeball the ⌕/❯/$/? routes in the debug app.
- **Residual risk:** Untested visual states (drop-target ring, errored tint) — covered
  by keeping those rules on legacy selectors untouched.

**Risk R02: Flash overlay coordinates drift in content space** {#r02-overlay-coords}

- **Risk:** Converting viewport rects to scroller-content coordinates mis-places the
  ring when the scroller has borders/padding.
- **Mitigation:** Compute against `scroller.getBoundingClientRect()` +
  `scroller.scrollTop/scrollLeft` including `clientLeft/clientTop`; at0221 asserts the
  overlay rect overlaps the active-match rect.
- **Residual risk:** Sub-pixel offsets — cosmetic only.

---

### Design Decisions {#design-decisions}

#### [P01] Scroll-as-you-type: reveal keyed on active-match identity (DECIDED) {#p01-identity-reveal}

**Decision:** The transcript host reveals whenever the **active match identity**
`(row, segment, start)` changes — or `wrapSeq` bumps — not when the numeric
`activeIndex` changes.

**Rationale:**
- `DevFindSession.setMatches` preserves the active match by identity when it survives a
  re-search and clamps to the first match otherwise. Keying the reveal on identity
  means: while typing, if your current match still matches, you stay put; the moment
  the active match becomes a different one (including the common "first match moved"
  case), the transcript follows it. Once the user has started a find, the find is what
  the UI favors.
- Keying on `wrapSeq` re-reveals (and re-flashes) on a wrap even when `n == 1` and the
  identity is unchanged.

**Implications:**
- `findPrevActiveRef` in `dev-card-transcript.tsx` becomes an identity key (e.g.
  `"row:segment:start:wrapSeq"` string, or a small struct), reset when matches empty.
- The reveal now runs on most keystrokes while typing a narrowing query — the band
  check ([P02]) must be cheap (it is: one rect + one scroller rect per reveal).

#### [P02] The visible band has two edges (DECIDED) {#p02-visible-band}

**Decision:** After painting, the host nudges `scroller.scrollTop` until the
active-match rect lies inside the band
`[scrollerRect.top + --tugx-pin-stack-top + 8, scrollerRect.bottom − 8]` — bottom edge
enforced first, then top (so a rect taller than the band keeps its top visible).

**Rationale:**
- The existing nudge handles only the top (sticky pinned chrome). Overscan-mounted
  rows below the fold produce active rects below `scrollerRect.bottom` — visually
  "under the prompt entry", since the entry is the scroller's flex sibling below it.
- Live DOM Ranges track scrolls, so the rect can be re-read (or adjusted) after each
  nudge without repainting.

**Implications:**
- The reveal helper in `dev-card-transcript.tsx` grows a bottom-edge branch; the flash
  fires only after the band is satisfied.
- If follow-bottom (the "scroll to latest" machinery) would override the programmatic
  nudge during streaming, the reveal must disengage it — verify and handle in Step 1.

#### [P03] The flash overlay lives inside the scroller (DECIDED) {#p03-overlay-in-scroller}

**Decision:** `TranscriptFindHighlighter` appends the flash ring to the transcript
scroller (the `data-tug-scroll-key="dev-card-transcript"` element) as
`position: absolute` in content coordinates, instead of `position: fixed` on
`document.body`. The paint input carries the scroller so the highlighter can place and
contain it. If the settled active rect is still outside the scroller's visible box,
the flash is skipped entirely.

**Rationale:**
- Absolute-in-scroller means the ring scrolls with the content, is clipped by the
  card's overflow, and can never paint over the prompt entry or any other chrome.
- A fixed body-level overlay is out of flow: it detaches when content streams in and
  paints over whatever happens to be at those viewport coordinates.
- `.tug-list-view` is already `position: relative` — no CSS change needed on the
  scroller.

**Implications:**
- `FindPaintInput` gains `scroller: HTMLElement | null`; `flashActive()` uses the
  stored scroller (no-op without one). `clear()` / `dispose()` remove the overlay as
  today.
- `.tugx-find-flash-overlay` CSS flips `fixed` → `absolute`; the `z-index` can drop to
  a small value scoped inside the scroller.

#### [P04] `TugEntryShell` — one structural shell, two hosts (DECIDED) {#p04-entry-shell}

**Decision:** Extract the prompt entry's structural zones into a new stateless tugways
component `TugEntryShell` (`tug-entry-shell.tsx` + `tug-entry-shell.css`): the panel
(surface + `:focus-within` tint), the input area (editor slot), an optional status row
and optional accessory row (Z4C), and the toolbar (leading slot, flanking spacers,
centred slot, trailing slot, `data-tug-focus="refuse"`). `TugPromptEntry` is refactored
to compose the shell; `TextCardFindBar` composes the same shell. **Zone elements carry
both the shell class and any host-passed legacy class** — shared layout/appearance CSS
migrates verbatim to `.tug-entry-shell*` selectors, while prompt-entry-specific rules
(and every existing app-test selector) keep matching on the legacy
`.tug-prompt-entry*` classes, which remain on the same elements.

**Rationale:**
- This is the component-library answer: the two find faces are identical *by
  construction* because they are the same component — no copied CSS, no drift.
- The both-classes technique makes the refactor near-zero-churn: 12+ app-tests and all
  prompt-entry-specific CSS reference `.tug-prompt-entry*` selectors and continue to
  work unchanged.
- The shell is layout + surface only (no state, no responders) — hosts own behavior,
  per the entry's existing division of labor.

**Implications:**
- Shared CSS custom properties move with the shell:
  `--tugx-entry-shell-surface`, `--tugx-entry-shell-editor-rest`,
  `--tugx-entry-shell-editor-focus` replace the `--tugx-prompt-entry-{surface,
  editor-rest,editor-focus}` aliases; prompt-entry-only rules that referenced the old
  names (the Z4C attachment surface rules) re-point at the shell vars.
  `--tugx-prompt-entry-errored` stays prompt-entry-side.
- See Spec S01 (#s01-entry-shell-api) for the exact prop surface and Table T01
  (#t01-css-migration) for the rule-by-rule CSS migration.

#### [P05] The Text card find bar is the Dev entry's face minus Z4A/Z2 (DECIDED) {#p05-find-bar-face}

**Decision:** `TextCardFindBar` is rebuilt as: `TugEntryShell` containing a
`TugTextEditor` (CM6 substrate, borderless, one-line min height, `maxRows={6}`,
placeholder "Find in file") above a toolbar whose centred slot holds the shared
`TugFindCluster` and whose trailing slot holds the Z5 pair — `TugPushButton`
`subtype="icon" size="lg"` outlined ChevronUp ("Find previous") and filled ChevronDown
("Find next"), exactly the props the Dev entry mounts on the ⌕ route. No Z4A route
popup, no Z2 status row, and **no ✕ button** — Escape dismisses (and ⌘F summons, as
today).

**Rationale:**
- "It should look just the same": same substrate, same cluster, same buttons, same
  shell — the only differences are the absent Z4A/Z2 occupants.
- The engine is untouched: the bar still drives
  `TugTextCardEditorDelegate.setSearchQuery/findNext/findPrevious/getMatchInfo`, and
  options still read/write the global preference (`readFindOptions`/`putFindOptions`).

**Implications:**
- The `TugInput`-based bar, its ✕ button, and its bespoke CSS are deleted;
  `text-card-find-bar.css` shrinks to docking rules (divider against the status bar,
  `--tug-text-editor-min-height: 0` so the editor opens one line tall and grows).
- Query mirroring uses an `EditorView.updateListener` passed via the substrate's
  `extensions` prop (the same technique `TugPromptEntry` uses for its ⌕ query mirror)
  — no controlled-input round-trip.

#### [P06] The count is a single-line `TugBadge`, tinted/action (DECIDED) {#p06-count-badge}

**Decision:** `TugFindCluster` renders the count face inside
`<TugBadge emphasis="tinted" role="action" size="sm">` — the same coloration as the
Z4B Model / Mode / Effort chips — single-line layout, wrapping the existing
`TugStableOverlay` (alternates `"No results"`, `"888 of 888"`) as the badge's
children. The badge keeps `data-slot="find-count"` (and the inner
`data-slot="find-count-value"` span) so existing app-test selectors hold. When there
is no query the badge is hidden via CSS (`visibility: hidden`), never unmounted, so
the cluster's width stays stable.

**Rationale:**
- A bare text run in Z4B reads as unfinished; the badge gives it the chip vocabulary
  of its neighbors. Badges are intrinsically non-interactive ("a badge is a fancy,
  colourful label — never a button"), so "unclickable" is free.
- Keeping `TugStableOverlay` inside the badge (rather than the badge's own
  `widthStabilize`, which takes a single alternate) reserves for both alternate faces.

**Implications:**
- `tug-find-cluster.tsx` swaps the count `<span>` for the badge; `tug-find-cluster.css`
  gains the hidden-when-queryless rule keyed on an empty
  `[data-slot="find-count-value"]`; the old text-run styling for `.tugx-find-count` is
  reduced to layout.

#### [P07] Find-bar Return semantics: Enter advances (DECIDED) {#p07-return-semantics}

**Decision:** In the Text card's find bar, Enter → next match, Shift-Enter → previous
match, Escape → dismiss.

**Rationale:**
- The Dev entry's ⌕ route maps Return to *newline* (`RETURN_ACTION_BY_ROUTE["⌕"] =
  "newline"`) because that editor doubles as the multi-line prompt editor. The Text
  card's bar is a dedicated find field — the universal find-bar convention (Enter
  advances) is what the user expects there, and it is the behavior the shipped bar
  already has (at0223 exercises it).

**Implications:**
- Implemented as `Prec.high(keymap.of(...))` in the substrate `extensions` (Enter,
  Shift-Enter, Escape), so CM6's default Enter-newline never runs in the bar.

---

### Deep Dives {#deep-dives}

#### Current reveal-path anatomy {#reveal-anatomy}

All in `tugdeck/src/components/tugways/cards/dev-card-transcript.tsx`, inside the
`useEffect` that consumes `findSnap` (the `DevFindSession` snapshot via
`useSyncExternalStore`):

- `findPrevActiveRef: useRef<number>(-1)` — the numeric previous active index; the
  reveal gate is `activeIndex !== findPrevActiveRef.current`. **This is the
  first-result bug**: query refinement keeps `activeIndex === 0`.
- On reveal: `listViewRef.current?.scrollToIndex(activeRow, { block: "nearest" })`,
  then a rAF-driven `paintAndReveal(attempt)` loop (bounded 8 attempts) that paints,
  unfolds hidden matches through the `FindTargetRegistry`, and for `dom`-segment
  matches performs the **top-only** sticky-clear nudge: reads
  `--tugx-pin-stack-top` off the root, computes
  `visibleTop = scrollerRect.top + stickyTop + 8`, and if `rect.top < visibleTop`
  subtracts the difference from `scroller.scrollTop`. Then `highlighter.flashActive()`.
- The scroller is found via
  `root.querySelector('[data-tug-scroll-key="dev-card-transcript"]')`.
- `editor`-segment matches return early before the nudge (CM6 reveals internally).
- A separate `handleFindRenderedRangeChange` callback repaints (no flash, no scroll)
  when the virtualized window turns over.

Step 1 changes only this host effect: identity+wrapSeq key ([P01]) and the two-edge
band ([P02]). The bounded-unfold retry loop and the editor-segment early return stay.

#### Flash overlay anatomy {#flash-anatomy}

`tugdeck/src/components/tugways/transcript-find-highlighter.ts`:
`flashActive()` reads `activeRangeRect()` (viewport coords of the live active Range),
creates a `div.tugx-find-flash-overlay`, sets `left/top/width/height` from the rect,
appends to `document.body`, and removes it after `FLASH_MS = 640`. CSS
(`transcript-find.css`) is `position: fixed; z-index: 9999` with a one-shot
`box-shadow` ring animation. Step 2 re-parents per [P03]: content coordinates are
`rect.left − scrollerRect.left − scroller.clientLeft + scroller.scrollLeft` (and the
`top` analogue), appended to the scroller.

#### Prompt-entry zone anatomy and what the shell absorbs {#entry-zone-anatomy}

`tugdeck/src/components/tugways/tug-prompt-entry.tsx` renders (inside its
`ResponderScope` / route-lifecycle provider):

```
div.tug-prompt-entry                    ← root: surface, focus-within tint, drag
  div.tug-prompt-entry-status           ← Z2 (optional; statusContent/cautionContent)
  div.tug-prompt-entry-input-area       ← editor wrapper (editorStopRef, tabIndex)
    TugTextEditor (borderless, maxRows 20, extensions incl. query mirror)
  div.tug-prompt-entry-attachments      ← Z4C (optional; compose-phase previews)
  div.tug-prompt-entry-toolbar          ← data-tug-focus="refuse"
    TugPopupMenu(route trigger)         ← Z4A
    div.tug-prompt-entry-toolbar-spacer
    div.tug-prompt-entry-indicators     ← Z4B (indicatorsContent prop; centred [D05])
    div.tug-prompt-entry-toolbar-spacer
    [queue + / find-previous button]    ← Z5 secondary (route/mode-conditional)
    TugPushButton.tug-prompt-entry-submit-button  ← Z5 primary (ONE node, [L26])
```

On the ⌕ route the Z5 pair is: secondary `TugPushButton subtype="icon" size="lg"
emphasis="outlined" role="action"` with `ChevronUp size={18} strokeWidth={2.5}`
(`aria-label="Find previous"`), primary submit button with
`ChevronDown size={18} strokeWidth={2.5}` (`aria-label="Find next"`). The Text card
bar mounts this exact pair ([P05]).

The shell absorbs the *layout positions*; every occupant stays host-owned. External
dependents on the legacy class names (kept by the both-classes rule, [P04]):
`tug-prompt-entry-submit-button.ts`, its unit test, and app-tests at0050, at0084,
at0085, at0086, at0103, at0104, at0140, at0157, at0204, at0215, at0216, at0221,
at0222.

#### Substrate facts the find bar relies on {#substrate-facts}

`tugdeck/src/components/tugways/tug-text-editor.tsx`:

- Registers its own responder handlers for editing actions (Cmd-A/C/X/V/Z work in any
  mount — the substrate-responder requirement is satisfied internally).
- `extensions?: Extension | readonly Extension[]` prop — the seam for the bar's
  `Prec.high` keymap ([P07]) and its `EditorView.updateListener` query mirror (the
  prompt entry mirrors its ⌕ query into `DevFindSession.setQuery` the same way).
- `TugTextEditorDelegate.focus()` — the bar focuses the editor on mount.
- Host min-height rides `--tug-text-editor-min-height` (default 0 → one line); the
  Dev card sets its own tall floor in `dev-card.css`, the find bar sets none.
- `borderless` + the shell's editor-flush rules (border-radius 0, cm background
  consolidation) make the substrate read as part of the panel.

#### Text-card wiring that stays {#text-card-wiring}

`tugdeck/src/components/tugways/cards/text-card.tsx`: `findOpen` state mounts the bar
between `TugTextCardEditor` and `TextCardStatusBar`; `openFindBar` is the editor's
`onFindRequested` (⌘F); `closeFindBar` clears the search (`editorRef.current?.
clearSearch()`) and refocuses the editor. All unchanged. The bar's engine surface —
`TextCardFindSurface` over `TugTextCardEditorDelegate.getMatchInfo()` (cursor walk,
`MATCH_INFO_CAP = 5000`, `N+` when capped), `setSearchQuery`, `findNext`,
`findPrevious` — is reused verbatim from the current `text-card-find-bar.tsx`.

#### Test selectors that must keep working {#test-selectors}

- at0221: `[data-card-id="A"] [data-slot="find-count"] [data-slot="find-count-value"]`
  — preserved by [P06].
- at0223: `[data-slot="text-card-find-bar"]` root; the input selector
  (`data-testid="text-card-find-input"`) changes to the CM6 substrate — at0223 is
  reworked in Step 6 (typing goes to the focused editor via `nativeType`; the chip
  selector is unchanged).

---

### Specification {#specification}

**Spec S01: `TugEntryShell` API** {#s01-entry-shell-api}

New file `tugdeck/src/components/tugways/tug-entry-shell.tsx`.

The shell is a **`React.forwardRef<HTMLDivElement, TugEntryShellProps>`** component —
the forwarded ref lands on the root `div`. This is load-bearing for the prompt entry:
it composes `rootRef + responderRef` onto its root element (one callback ref), and the
root ref feeds the substrate's `data-empty` bridge (an `EditorView.updateListener`
writes the attribute through `rootRef.current` on every doc change — the
`[data-empty="true"]` queue-button gating CSS depends on it, per [L22]) while
`responderRef` is the entry's responder-chain registration.

```tsx
export interface TugEntryShellProps
  extends React.ComponentPropsWithoutRef<"div"> {
  /** Z2 — optional status strip rendered above the input area. */
  statusRow?: React.ReactNode;
  /** Z4C — optional accessory row between the input area and the toolbar. */
  accessoryRow?: React.ReactNode;
  /** Z4A — leading-fixed toolbar slot. Omitted ⇒ nothing renders; the
   *  flanking spacers still centre the middle slot in the full width. */
  toolbarLeading?: React.ReactNode;
  /** Z4B — centred-floating toolbar slot ([D05] centring via two equal
   *  flex spacers). */
  toolbarCenter?: React.ReactNode;
  /** Z5 — fixed-trailing toolbar slot (one or more buttons). */
  toolbarTrailing?: React.ReactNode;
  /** Extra class for the input-area wrapper (legacy host class). */
  inputAreaClassName?: string;
  /** Ref / tabIndex forwarded to the input-area wrapper (the prompt entry
   *  authors it as a focus-cycle stop). */
  inputAreaRef?: React.Ref<HTMLDivElement>;
  inputAreaTabIndex?: number;
  /** Extra class for the toolbar row (legacy host class). */
  toolbarClassName?: string;
  /** The editor substrate. */
  children: React.ReactNode;
}
```

Render shape (all `div`s; root carries the forwarded ref and spreads `...rest` so
hosts keep their drag handlers, `inert`, and `data-*` attributes):

```
div.tug-entry-shell[className]
  {statusRow}
  div.tug-entry-shell-input-area[inputAreaClassName][ref][tabIndex]
    {children}
  {accessoryRow}
  div.tug-entry-shell-toolbar[toolbarClassName] data-tug-focus="refuse"
    {toolbarLeading}
    div.tug-entry-shell-toolbar-spacer aria-hidden
    div.tug-entry-shell-indicators data-slot="entry-shell-indicators"
      {toolbarCenter}
    div.tug-entry-shell-toolbar-spacer aria-hidden
    {toolbarTrailing}
```

The shell is stateless and law-inert: no store reads, no responders, no focus claims.
`TugPromptEntry` passes `className="tug-prompt-entry"`,
`inputAreaClassName="tug-prompt-entry-input-area"`,
`toolbarClassName="tug-prompt-entry-toolbar"`, and renders its status /
attachments / Z4A / indicators / Z5 occupants (with their legacy classes and
data-slots) into the slots.

**Table T01: CSS migration (tug-prompt-entry.css → tug-entry-shell.css)** {#t01-css-migration}

| Rule (current selector) | Disposition |
|---|---|
| `--tugx-prompt-entry-surface` / `-editor-rest` / `-editor-focus` aliases | Move; rename `--tugx-entry-shell-*`; prompt-entry Z4C rules re-point |
| `.tug-prompt-entry` root layout + surface + transition | Move → `.tug-entry-shell` |
| `.tug-prompt-entry:focus-within` tint | Move → `.tug-entry-shell:focus-within` |
| `.tug-prompt-entry-input-area` layout | Move → `.tug-entry-shell-input-area` |
| input-area editor-flush radius rules (`> .tug-text-editor`, `> … > .cm-editor`) | Move, re-keyed |
| `.cm-editor` background consolidation (rest / focused) | Move → `.tug-entry-shell .tug-text-editor .cm-editor…` |
| `.tug-prompt-entry .tug-text-editor { border-width: 0 }` | Move, re-keyed |
| input-area / editor key-state outline kill (`[data-key-view-kbd]` etc.) | Move, re-keyed (any shell host with a focus-stop input area needs it) |
| `.tug-prompt-entry-toolbar` row | Move → `.tug-entry-shell-toolbar` |
| `.tug-prompt-entry-toolbar-spacer` | Move → `.tug-entry-shell-toolbar-spacer` |
| `.tug-prompt-entry-indicators` | Move → `.tug-entry-shell-indicators` |
| `[data-disabled]` opacity | Stays (legacy class on the same root element) |
| Z4C attachments block + surface pairing | Stays (re-points at shell vars) |
| Route-trigger selection coloration | Stays |
| kbd-hint `::after`, drop-target rules | Stays (legacy input-area class still present) |
| `data-empty` queue-button gating; submit-button `data-mode` colors | Stays |
| `[data-errored]`, `[data-phase="awaiting_approval"]`, status-row rules | Stays |

**Spec S02: rebuilt `TextCardFindBar` composition** {#s02-find-bar-composition}

```tsx
<TugEntryShell
  className="text-card-find-bar"
  data-slot="text-card-find-bar"
  toolbarCenter={<TugFindCluster surface={surface} />}
  toolbarTrailing={
    <>
      <TugPushButton subtype="icon" size="lg" emphasis="outlined" role="action"
        icon={<ChevronUp size={18} strokeWidth={2.5} />}
        aria-label="Find previous" onClick={() => navigate("previous")} />
      <TugPushButton subtype="icon" size="lg" emphasis="filled" role="action"
        icon={<ChevronDown size={18} strokeWidth={2.5} />}
        aria-label="Find next" onClick={() => navigate("next")} />
    </>
  }
>
  <TugTextEditor
    borderless
    maxRows={6}
    placeholder="Find in file"
    preserveState={false}
    extensions={findBarExtensions /* Prec.high keymap + updateListener */}
  />
</TugEntryShell>
```

- `preserveState={false}` is required: the substrate defaults `preserveState` to
  `true` and would mount its state-preservation hook, but the Text card already owns
  its card-state-preservation slot (`useCardStatePreservation` in `text-card.tsx`),
  and a transient find field must not stash editor state into the card bag — the same
  opt-out `TugPromptEntry` applies to its own substrate.

- `findBarExtensions`: `Prec.high(keymap.of([{Enter → next}, {Shift-Enter →
  previous}, {Escape → onClose}]))` plus `EditorView.updateListener.of(update ⇒ if
  (update.docChanged) mirror doc → runSearch + surface.refresh)`.
- The delegate ref (`TugTextEditorDelegate`) focuses the editor on mount.
- `TextCardFindSurface`, `runSearch`, `navigate`, and the global-options
  seed/write-back (`readFindOptions` / `putFindOptions` / `DEFAULT_FIND_OPTIONS`)
  carry over from the current file unchanged.
- `text-card-find-bar.css` reduces to: a top divider against the editor above, and
  bar-scoped substrate sizing (`--tug-text-editor-min-height: 0`).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Previous active-match identity key | local-data (host effect memory) | `useRef` in `dev-card-transcript.tsx` | — |
| Reveal scroll nudges (both edges) | appearance | effect reacting to store snapshot writes `scroller.scrollTop` | [L02], [L06] |
| Flash overlay element | appearance | imperative DOM child of the scroller, CSS-animated | [L06] |
| Count badge face | derived render | `FindSurface` snapshot via `useSyncExternalStore` (existing) | [L02] |
| Badge hidden-when-queryless | appearance | CSS `visibility` keyed on empty value slot | [L06] |
| `TugEntryShell` | none (stateless layout) | props only | [L19] |
| Find-bar query | local-data | CM6 doc is the source; `updateListener` mirrors into the search + surface refresh | [L22]-adjacent (no React round-trip) |
| Find-bar open/closed | structure | existing `useState` in `text-card.tsx` (unchanged) | — |
| Find-bar option toggles | local-data + persistence | existing `useState` + `putFindOptions` write-through (unchanged) | [L11] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-entry-shell.tsx` | Shared entry shell (Spec S01) |
| `tugdeck/src/components/tugways/tug-entry-shell.css` | Shell layout/surface CSS (Table T01) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugEntryShell`, `TugEntryShellProps` | component / interface | `tug-entry-shell.tsx` | new; `forwardRef` to the root div |
| `FindPaintInput.scroller` | field | `transcript-find-highlighter.ts` | `HTMLElement \| null`; stored for flash |
| `TranscriptFindHighlighter.flashActive` | method | `transcript-find-highlighter.ts` | absolute-in-scroller placement; skip when rect outside scroller box |
| find reveal effect | effect | `cards/dev-card-transcript.tsx` | identity+wrapSeq key; two-edge band |
| `TugFindCluster` count face | JSX | `tug-find-cluster.tsx` | `TugBadge` wrapper ([P06]) |
| `TugPromptEntry` render body | refactor | `tug-prompt-entry.tsx` | composes `TugEntryShell`; occupants unchanged |
| `TextCardFindBar` | rewrite | `cards/text-card-find-bar.tsx` | Spec S02 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/app-test-inventory.md`: update the [AT0221] and [AT0223] summary rows
      as those tests change (Steps 3 and 6).
- [ ] `tug-entry-shell.tsx` module docstring documents the shell contract (zones,
      both-classes hosting rule, statelessness) — the component doc is the reference;
      no freestanding doc file.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (real app)** | Drive the real Tug.app: reveal geometry, overlay containment, bar anatomy | at0221 (extended), at0223 (reworked), prompt-entry battery (regression) |
| **Unit (`bun:test`)** | Pure logic only | none new needed — the changed logic is DOM/geometry, which unit tests can't honestly exercise |
| **Build gates** | Type + bundle integrity | `tsc --noEmit`, `vite build` per step |

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL render tests and no mock-store assertions (banned patterns) — the
  shell and the bar are proven in the real app via app-tests.
- No unit test of coordinate math in isolation — the at0221 containment assertions
  (overlay inside scroller, active rect inside band) test the same math against real
  layout, which is the only truth that matters.
- Prompt-entry behavior is not re-specified — the existing battery (at0050, at0085,
  at0103, at0104, at0204, at0215, at0216, at0222) is the regression net for Step 4.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Build/typecheck with the project-local
> binaries: `cd tugdeck && ./node_modules/.bin/tsc --noEmit` and
> `./node_modules/.bin/vite build`. App-tests run from the repo root:
> `just app-test tests/app-test/<file>` (check `tail -n 1` for `VERDICT: PASS`).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Reveal on identity, two-edge visible band | done | `c93369379` |
| #step-2 | Flash overlay into the scroller | done | `31d9f7d12` |
| #step-3 | at0221: reveal + containment scenarios | done | `87b2aa644` |
| #step-4 | Count badge in the shared cluster | done | `2bcfdf2e4` |
| #step-5 | TugEntryShell extraction; prompt entry composes it | done | `929d9a13b` |
| #step-6 | Text card find bar on the shell | done | `a37ee34f2` |
| #step-7 | Integration checkpoint | done | N/A (verification only) |

#### Step 1: Reveal on identity, two-edge visible band {#step-1}

**Commit:** `tugdeck(find): reveal active match on identity change into a two-edge visible band [L02][L06]`

**References:** [P01] identity reveal, [P02] visible band, (#reveal-anatomy, #context)

**Artifacts:**
- Modified find-reveal effect in
  `tugdeck/src/components/tugways/cards/dev-card-transcript.tsx`.

**Tasks:**
- [x] Replace `findPrevActiveRef: useRef<number>(-1)` with an identity key of the
      active match — `row`, `segment`, `start`, plus the session's `wrapSeq` — reset
      to a sentinel when matches empty. Reveal when the key changes.
- [x] Extend the post-paint nudge in `paintAndReveal` to enforce both band edges per
      [P02]: bottom first (`rect.bottom > scrollerRect.bottom − 8` ⇒ scroll down),
      then top (existing pin-stack rule). Re-read the rect between nudges (live
      Ranges track scroll).
- [x] Keep the bounded unfold-retry loop, the `editor`-segment early return, and
      `handleFindRenderedRangeChange` untouched.
- [x] Verify against follow-bottom: with a turn streaming, run a find and navigate;
      if the follow-bottom machinery overrides the reveal nudge, disengage it when a
      reveal runs (find is favored once underway — [P01] rationale). Record what was
      needed in the commit message.

**Tests:**
- [x] Covered by Step 3's at0221 scenarios (kept separate so this step's commit is
      reviewable on its own; manual verification in the debug app here).

**Checkpoint:**
- [x] `cd tugdeck && ./node_modules/.bin/tsc --noEmit`
- [x] In the debug app: type a query on ⌕ whose first match is far below — the
      transcript scrolls to it as you type; ⌘G to a bottom-area match never leaves it
      under the entry region.
- [x] `just app-test tests/app-test/at0221-transcript-find-fidelity.test.ts` still
      passes (existing scenarios unbroken).

---

#### Step 2: Flash overlay into the scroller {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(find): flash overlay rides the scroller — absolute, clipped, scroll-tracking [L06]`

**References:** [P03] overlay in scroller, Risk R02, (#flash-anatomy)

**Artifacts:**
- Modified `tugdeck/src/components/tugways/transcript-find-highlighter.ts` and
  `tugdeck/src/components/tugways/transcript-find.css`.

**Tasks:**
- [x] Add `scroller: HTMLElement | null` to `FindPaintInput`; the highlighter stores
      it each paint. `dev-card-transcript.tsx` passes the
      `[data-tug-scroll-key="dev-card-transcript"]` element from both paint sites.
- [x] Rework `flashActive()`: no-op without a scroller; convert the active rect to
      content coordinates (subtract `scrollerRect.left/top` and `clientLeft/Top`, add
      `scrollLeft/Top`); append the overlay to the scroller; skip the flash when the
      rect does not intersect the scroller's visible box.
- [x] CSS: `.tugx-find-flash-overlay` → `position: absolute`; drop the body-level
      `z-index: 9999` for a small scroller-scoped value.
- [x] `removeFlashOverlay` / `clear()` / `dispose()` continue to remove the element.

**Tests:**
- [x] Covered by Step 3's containment assertions.

**Checkpoint:**
- [x] `cd tugdeck && ./node_modules/.bin/tsc --noEmit`
- [x] Debug app: the ring lands on the match, scrolls with the content mid-flash, and
      never appears over the prompt entry or status bar.

---

#### Step 3: at0221 — reveal + containment scenarios {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `app-test(at0221): scroll-as-you-type reveal, two-edge band, overlay containment`

**References:** [P01], [P02], [P03], (#test-selectors, #success-criteria)

**Artifacts:**
- Extended `tests/app-test/at0221-transcript-find-fidelity.test.ts`; updated summary
  row in `tuglaws/app-test-inventory.md`.

**Tasks:**
- [x] Scenario: viewport at transcript top, type (synthetic keydowns / nativeType) a
      query whose only match lies far below → poll until the active-match rect (via
      the painted active highlight / `waitForActiveText` helpers already in the file)
      sits inside the band `[scrollerRect.top + pinStack + 8, scrollerRect.bottom −
      8]`.
- [x] Scenario: query refinement — type a short query with a nearby first match, then
      extend it so the first match moves elsewhere → assert the transcript re-revealed
      (active rect back inside the band).
- [x] Scenario: navigate (⌘G synthetic keydown) to a match in the last visible row
      region → assert `rect.bottom ≤ scrollerRect.bottom` (never under the entry).
- [x] Scenario: immediately after a navigation, query `.tugx-find-flash-overlay` →
      assert it exists, is a DOM descendant of the
      `[data-tug-scroll-key="dev-card-transcript"]` element, and its bounding rect is
      contained by (and overlaps the active rect within) the scroller's rect. Poll
      fast — the overlay lives 640 ms.

**Tests:**
- [x] The scenarios above are the tests.

**Checkpoint:**
- [x] `just app-test tests/app-test/at0221-transcript-find-fidelity.test.ts` →
      `VERDICT: PASS`

---

#### Step 4: Count badge in the shared cluster {#step-4}

**Commit:** `tugdeck(find): match count in a TugBadge (tinted/action) in the shared find cluster [L02][L06]`

**References:** [P06] count badge, (#test-selectors)

**Artifacts:**
- Modified `tugdeck/src/components/tugways/tug-find-cluster.tsx` and
  `tug-find-cluster.css`.

**Tasks:**
- [x] Replace the count `<span className="tugx-find-count">` with
      `<TugBadge emphasis="tinted" role="action" size="sm"
      className="tugx-find-count" data-slot="find-count" aria-live="polite">`
      whose children are the existing `TugStableOverlay` (active face keeps
      `data-slot="find-count-value"`; alternates `"No results"`, `"888 of 888"`).
      Note: `TugBadge` spreads rest props after its own `data-slot="tug-badge"`, so
      the caller's `data-slot` wins — verify in the DOM.
- [x] CSS: hide the badge (`visibility: hidden`) when the value slot is empty (no
      query), keeping it mounted for stable cluster width; trim the old text-run
      styling.
- [x] Confirm at0221's chip selector
      (`[data-slot="find-count"] [data-slot="find-count-value"]`) and at0223's
      still resolve.

**Tests:**
- [x] Existing at0221 count assertions exercise the badge face end-to-end.

**Checkpoint:**
- [x] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
- [x] `just app-test tests/app-test/at0221-transcript-find-fidelity.test.ts` and
      `tests/app-test/at0223-text-card-find-bar.test.ts` → `VERDICT: PASS`
- [x] Debug app: the ⌕ route's Z4B shows the count as a tinted action pill matching
      the Mode/Model/Effort chips; it is not clickable.

---

#### Step 5: TugEntryShell extraction; prompt entry composes it {#step-5}

**Commit:** `tugdeck(tugways): extract TugEntryShell from TugPromptEntry — one structural shell, zero drift [L19][L20][D05]`

**References:** [P04] entry shell, Spec S01, Table T01, Risk R01, (#entry-zone-anatomy)

**Artifacts:**
- New `tugdeck/src/components/tugways/tug-entry-shell.tsx` + `tug-entry-shell.css`.
- Refactored `tug-prompt-entry.tsx`; slimmed `tug-prompt-entry.css`.

**Tasks:**
- [x] Create `TugEntryShell` per Spec S01 (stateless; `React.forwardRef` with the ref
      on the root div; root spreads rest props; toolbar carries
      `data-tug-focus="refuse"`; two flanking spacers centre the middle slot per
      [D05]).
- [x] Move the shared rules per Table T01 into `tug-entry-shell.css`, re-keyed to
      `.tug-entry-shell*` selectors and `--tugx-entry-shell-*` vars; re-point the
      prompt entry's Z4C surface rules at the shell vars; leave every
      prompt-entry-specific rule in `tug-prompt-entry.css` on its legacy selector.
- [x] Refactor `TugPromptEntry`'s render body to compose the shell: root
      `className="tug-prompt-entry"` + drag handlers + `inert`/`data-*` via rest; the
      entry's composed `rootRef + responderRef` callback goes to the shell's
      forwarded root ref (preserving the `data-empty` bridge — the substrate
      updateListener writing through `rootRef.current` — and the responder-chain
      registration);
      status row, attachments (accessoryRow), route popup (toolbarLeading),
      indicators content (toolbarCenter, keeping the
      `.tug-prompt-entry-indicators`/`data-slot` wrapper as the occupant), queue /
      find-previous / submit buttons (toolbarTrailing); `inputAreaRef` =
      `editorStopRef`, `inputAreaTabIndex` as today,
      `inputAreaClassName="tug-prompt-entry-input-area"`,
      `toolbarClassName="tug-prompt-entry-toolbar"`.
- [x] Sweep for selector references to the migrated rules (`grep -rn
      "tug-prompt-entry-toolbar\|tug-prompt-entry-input-area"` across `src` and
      `tests/`) and confirm each still matches (the legacy classes remain on the same
      elements — no test edits expected).

**Tests:**
- [x] Regression only: the prompt-entry app-test battery (see checkpoint).
- [x] `bun test` (unit suite; `tug-prompt-entry-submit-button.test.ts` and the
      strip-and-migrate tests must be untouched-green).

**Checkpoint:**
- [x] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build && bun test`
- [x] `just app-test tests/app-test/at0085-prompt-entry-route.test.ts` and
      `tests/app-test/at0204-prompt-entry-text-surface.test.ts` and
      `tests/app-test/at0215-route-chrome.test.ts` and
      `tests/app-test/at0222-one-shot-commands.test.ts` → all `VERDICT: PASS`
- [x] Debug app: ❯/$/?/⌕ routes render pixel-identically (surface tint, focus tint,
      toolbar spacing, Z4B centring, Z5 placement, attachments zone, drop ring).

---

#### Step 6: Text card find bar on the shell {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `tugdeck(text-card): find bar rebuilt on TugEntryShell — the Dev entry's find face, minus Z4A/Z2 [L11][L19]`

**References:** [P05] find bar face, [P07] return semantics, Spec S02,
(#substrate-facts, #text-card-wiring, #test-selectors)

**Artifacts:**
- Rewritten `tugdeck/src/components/tugways/cards/text-card-find-bar.tsx`; rewritten
  `text-card-find-bar.css`; reworked
  `tests/app-test/at0223-text-card-find-bar.test.ts`; updated
  `tuglaws/app-test-inventory.md` row.

**Tasks:**
- [x] Rebuild the bar per Spec S02: shell + `TugTextEditor` (borderless, `maxRows=6`,
      placeholder "Find in file", `preserveState={false}` — the substrate defaults to
      `true`, and the Text card already owns its preservation slot) + centred
      `TugFindCluster` + trailing Z5 pair
      (outlined ↑ / filled ↓, `size="lg"`, icons `size={18} strokeWidth={2.5}`).
      Delete the `TugInput` face, the ✕ button, and their imports.
- [x] Wire `findBarExtensions`: `Prec.high` keymap (Enter → next, Shift-Enter →
      previous, Escape → `onClose`) + `EditorView.updateListener` mirroring the doc
      into `runSearch` + `surface.refresh` ([P07]; the query-mirror technique the
      prompt entry uses).
- [x] Focus the substrate on mount via the `TugTextEditorDelegate.focus()` seam.
- [x] Keep `TextCardFindSurface`, options seed/write-back, and `navigate` unchanged;
      keep `data-slot="text-card-find-bar"` on the shell root.
- [x] Rewrite `text-card-find-bar.css` to docking-only rules (top divider,
      `--tug-text-editor-min-height: 0`); the panel look comes from the shell.
- [x] Rework at0223: focus lands in the CM6 substrate on ⌘F (type via `nativeType`);
      Enter advances (two Returns reach "2 of 3" — first lands, second advances, as
      the shipped test learned); Shift-Enter retreats; Escape dismisses and refocuses
      the document editor; assert the bar contains a `.tug-entry-shell-toolbar`, the
      find cluster, the count badge, the two Z5 buttons, and NO route trigger / ✕.

**Tests:**
- [x] at0223 (reworked) is the proof.

**Checkpoint:**
- [x] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
- [x] `just app-test tests/app-test/at0223-text-card-find-bar.test.ts` → `VERDICT: PASS`
- [x] Debug app: side-by-side, the Text card bar and the Dev ⌕ entry read as the same
      component (minus route popup / status row); Cmd-A/C/V work in the bar's field.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [x] Full sweep: `just app-test` (repo root) → `VERDICT: PASS`.
- [x] `cd tugdeck && bun test && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build` — all clean.
- [x] Reconcile this plan's Step Status Ledger and checkboxes.

**Tests:**
- [x] The aggregate sweep is the test.

**Checkpoint:**
- [x] `just app-test` → `VERDICT: PASS`
- [x] `cd tugdeck && bun test` → 0 fail

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Transcript find that always brings the active match into the truly
visible band (scroll-as-you-type), a landing flash that lives in the scroll flow, a
badge-faced match count, and one shared entry shell rendering an identical find face
in the Dev card and the Text card.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Typing on ⌕ follows the first match; navigation never parks a match under the
      prompt entry (at0221).
- [x] The flash ring is scroller-contained and scroll-tracking (at0221).
- [x] The count renders in a tinted/action `TugBadge` in both surfaces (at0221 /
      at0223 / debug-app inspection).
- [x] `TugPromptEntry` composes `TugEntryShell` with zero behavioral drift
      (prompt-entry app-test battery green).
- [x] `TextCardFindBar` is the shell + substrate + cluster + Z5 pair, no Z4A/Z2/✕
      (at0223).
- [x] Full `just app-test` sweep, `bun test`, `tsc`, `vite build` all green.

**Acceptance tests:**
- [x] `tests/app-test/at0221-transcript-find-fidelity.test.ts` (extended)
- [x] `tests/app-test/at0223-text-card-find-bar.test.ts` (reworked)
- [x] Full `just app-test` sweep

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] ⌘G / ⇧⌘G match cycling inside the Text card ([Q01]).
- [ ] Migrate other bottom-docked entry-like surfaces onto `TugEntryShell` if any
      emerge (the shell is the designated home).
- [ ] Prior plan's standing follow-ons: smart plain-⌘F in the Dev card; DiffBlock /
      JsonTreeBlock / AgentTranscriptBlock searchability; find-and-replace.

| Checkpoint | Verification |
|------------|--------------|
| Reveal correctness | at0221 band scenarios |
| Overlay containment | at0221 overlay assertions |
| Shell zero-drift | prompt-entry app-test battery |
| One find face | at0223 + side-by-side inspection |
