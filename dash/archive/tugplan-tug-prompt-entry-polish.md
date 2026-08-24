# TugPromptEntry — polish + split-pane integration

**Status:** Drafting (rev 2 — user review applied)

**Parent roadmap:** [tide.md § T3.4.b](tide.md#t3-4-b-prompt-entry) — lands **between** T3.4.b (the base component) and T3.4.c (the Tide card / real backend wiring). Scoped to make the gallery card drive visible polish on the component before the real Tide mount; keeps backend composition unchanged.

**Why this is a separate doc:** `tugplan-tug-prompt-entry.md` shipped a component that assumed a self-contained card wrapper. Once the gallery card hosts the entry inside a `TugSplitPane`, several assumptions break:
- The entry's outer border competes with the pane's frame.
- The entry's fixed-height chrome doesn't stretch, so most of the pane is empty.
- The input's fixed `maxRows` ceiling never exercises the pane's vertical budget.
- The split pane's grabber pill dominates the UI on cards where it shouldn't.

These are layout/integration issues — not defects in the component itself — so they get their own plan rather than retrofitting the original.

---

## Requirements (from user review of gallery card)

1. **Hide the box border on the lower pane.** When `TugPromptEntry` fills a pane, its outer `1px border` is redundant with the pane's surrounding chrome and reads as a double-stroke.
2. **Entry always fills its split pane.** The entry should stretch to fill the pane's height, not hug its content at the top.
3. **Tools pinned to bottom.** The route indicator + submit button row sits at the *bottom* of the entry, not immediately beneath the input. The gap between the input and the toolbar is empty input space (or transcript overflow, in T3.4.c).
4. **Input fills the space between the top of the entry and the toolbar.** Scrolling only starts when the input can no longer grow its containing pane.
5. **Input grows upward on Return, pushing its pane upward.** *(New feature.)* Adding a line to the input should expand the input's height; that expansion should push the split-pane sash upward, reducing the top pane's size. The input does not scroll internally until the pane is at its max allowed size.
6. **Bottom pane max 85% of the split pane's height.** Hard cap; when the pane hits 85%, further input growth switches to internal scrolling.
7. **Split pane — option to hide the grabber pill.** The grip pill on the sash is too prominent for this card. Add a prop to hide it (the sash line itself stays draggable; only the pill visual is suppressed).

**Added in rev 2 (user review):**

8. **File completion (`@`) must work in the gallery card.** The current card wires `fileCompletionProvider: () => []`, so `@`-trigger completion lists nothing. Wire the same provider the `gallery-prompt-input` card uses (`FileTreeStack` → file provider + command provider for `/`).
9. **TugBox needs a "zero-padding" option applied to the entry pane's box.** The entry-pane currently uses a plain `<div>` with `padding: var(--tug-space-sm)`. Swap it for a `TugBox` set to no inset so the entry truly fills the pane from edge to edge. (Existing `inset={false}` prop covers this — verify it fully zeros padding rather than just toggling a modifier class.)

---

## Track A — TugSplitPane polish {#track-a}

Scope: `tug-split-pane.tsx` + `.css`, and the gallery card's usage. Small, self-contained, non-breaking.

**A1. `showHandle` prop on `TugSplitPane`.**
- Signature: `showHandle?: boolean` (default `true`).
- Rendering: when `false`, the interleaved `<Separator>` still renders with its full hit area and keyboard affordance, but the handle pill (`.tug-split-sash-handle`) is visually suppressed (`display: none` or `visibility: hidden` — leaning `display: none` so the pill doesn't reserve space).
- Accessibility: the sash keeps its role/aria; only the decorative pill is hidden. The sash line (`::before`) stays visible so users still see *where* to drag.
- CSS approach: add `data-handle-hidden` attribute on `.tug-split-pane` or on each `.tug-split-sash`; style rule hides `.tug-split-sash-handle` when set. The handle's child `.tug-split-sash-grip` is inside the pill, so one selector covers both.

**A2. Gallery card uses `maxSize="85%"` on the bottom panel.** No new API — `TugSplitPanel` already supports `maxSize`. One-line change in `gallery-prompt-entry.tsx`.

**A3. Gallery card passes `showHandle={false}`.** One-prop change after A1 lands.

**Acceptance:**
- Dragging still works; sash line still visible.
- Gallery card: pill is gone; bottom panel can't exceed 85%.
- Other cards using `TugSplitPane` unaffected (`showHandle` defaults to `true`).

**Open questions:** none significant. `showHandle` is the standard name; alternatives (`hideGrabber`, `noHandle`) all work — going with `showHandle` for consistency with the existing React convention ("show/hide as boolean prop").

---

## Track B — TugPromptEntry as pane-filler {#track-b}

Scope: `tug-prompt-entry.tsx` + `.css`, and the gallery card's wrapper CSS. Bigger than Track A but still a layout reshuffle — no new feature.

**B1. Entry fills its container.**
- `.tug-prompt-entry` gets `flex: 1 1 auto; min-height: 0; height: 100%` so it stretches in a flex-column parent.
- Gallery card's `.gallery-prompt-entry-entry-pane` already is `display: flex; flex-direction: column`; the entry child just needs the flex grow.

**B2. Toolbar pinned to bottom.**
- Entry is already `display: flex; flex-direction: column`. Give the input wrapper `flex: 1 1 auto` so it consumes remaining space; the toolbar (second flex child) naturally stays at the bottom.
- No change to JSX order — the toolbar is already the second child.

**B3. Input fills the wrapper.**
- Pass `maximized` to `TugPromptInput` from inside the entry. The prop already exists and handles the flex chain (`.tug-prompt-input[data-maximized]` → `flex: 1`, editor → `flex: 1; overflow-y: auto`).
- When `maximized`, the input's editor takes all remaining space and scrolls internally when content overflows — exactly matching requirement #4.

**B4. Hide the entry's outer border when pane-filling.**

Two options:

- **(B4a) Unconditional removal.** Drop the `border` + `border-radius` + `padding` from `.tug-prompt-entry` entirely. Rationale: a component's outer chrome is a host concern; the entry was never meant to be used standalone anyway (the card always wraps it). Simpler, but a behavior change for anyone mounting the entry without a card.
- **(B4b) Prop-gated.** Add `chromeless?: boolean` (default `false`) that strips the outer border + radius + padding. The gallery card passes `chromeless`; future callers keep the current look unless they opt in.

**Recommendation: (B4a).** The outer border was added speculatively and turns out to always be double-stroke when used in practice. The component's real contract is "fill my parent"; the parent (card / pane / sheet) owns any framing.

**B5. Gallery card wrapper CSS.**
- Drop the extra padding on `.gallery-prompt-entry-entry-pane` (or reduce it) so the entry sits flush with the pane edges, letting the pane's frame do the visual separation.

**B6. Entry pane is a `TugBox` with `inset={false}` (rev 2).**
- Replace the plain `<div className="gallery-prompt-entry-entry-pane">` with `<TugBox inset={false} variant="plain">`. The existing `inset?: boolean` prop on `TugBox` already supports zero padding — verify the CSS fully zeros padding on `.tug-box[data-inset="false"]` (or the equivalent selector) rather than just nudging it down.
- If verification shows the prop doesn't fully zero padding, fix `tug-box.css` as part of this ticket — do not paper over it with a one-off override in the card.
- `variant="plain"` keeps the box invisible (it's a functional wrapper, not a framed surface).

**Acceptance:**
- Entry fills the bottom panel vertically.
- Toolbar sits at the pane's bottom edge regardless of input content.
- Single-line input: entry is mostly empty space above a single line of text; toolbar at bottom.
- Multi-line input (via `maximized` + natural content growth): the editor fills the available space and scrolls internally when overfull.
- No double border.

**Open questions:**
- **B4 choice.** Going with B4a unless a current caller depends on the outer border. A quick grep confirmed the only current caller is the gallery card itself.
- **Token pairing fallout.** If B4a removes the border, the `@tug-pairings` entry for `.tug-prompt-entry (border) — unified outer ring` disappears. That's one pairing fewer, no violation — but update the compact + expanded blocks and step-7's grep invariants won't regress.

---

## Track E — Content-driven panel sizing in TugSplitPane (supersedes Track C) {#track-e}

**Status: superseded.** The `autoSize` prop approach below accumulated complexity across a dozen iterations and was ultimately replaced by the reset plan in [`tugplan-autosize-reset.md`](./tugplan-autosize-reset.md). The replacement strips `TugSplitPane` to the minimal primitive (single sync-flag context + `TugSplitPanelHandle` imperative API) and pushes content-driven sizing into a consumer hook (`useContentDrivenPanelSize`). The sections below are preserved as history; do not implement from them.

**Scope:** `tug-split-pane.tsx` + `tug-prompt-input.tsx`. `TugPromptEntry` / gallery card are unmodified — zero consumer wiring beyond one boolean prop on `TugSplitPanel`.

### Goal

Adding a line to the input expands its rendered height; that expansion propagates upward and grows the split panel toward `maxSize`, pushing the sash upward. On submit (content clears, editor becomes `data-empty="true"`), the sash **snaps instantly back to the user-set anchor**. The anchor is the last size the user dragged to (tracked as a percentage of the group), or the library's resolved default if undragged. Persistence writes only happen on actual pointer release on a sash.

### Sizing formula

```
overflow = source.scrollHeight > source.clientHeight
chrome   = wrapperEl.clientHeight - source.offsetHeight
target   = empty    → userAnchor
           overflow → max(userAnchor, source.scrollHeight + chrome)
           else     → currentPx  (stable; no shrink mid-edit)
```

- `userAnchor` is stored as a percentage (0..100) of the group; converted to pixels on demand using the current `panel.getSize()` so window / card rewraps do not invalidate it.
- `source` is the descendant element tagged with `data-tug-auto-size-scroll-source` (typically the editor). `chrome` is derived — no constants.
- The `else → currentPx` branch exists because `scrollHeight` on an `overflow:auto` element clamps to `clientHeight` when content fits, so we cannot reliably distinguish "content exactly fills" from "content has room to spare". Shrinking on the fit condition would ping-pong. Only the explicit empty signal triggers snap-back; partial deletions stay at the grown size.

### API

```tsx
interface TugSplitPanelProps {
  /**
   * Observe own content (via a `[data-tug-auto-size-scroll-source]`
   * descendant); grow toward maxSize when content exceeds the
   * user-set anchor; snap instantly back to the anchor when the
   * source is empty (`data-empty="true"`).
   * @default false
   */
  autoSize?: boolean;
}
```

No ref prop. No chrome offset. No plumb-through on `TugPromptEntry`. No `autoSizeReturnDuration` (no animation; see below).

### Scroll-source contract

Any descendant element tagged with `data-tug-auto-size-scroll-source` is the natural-content-height signal. It MUST use `overflow-y: auto` (or equivalent) so its `scrollHeight` reports content intrinsic height on overflow. `data-empty="true"` on the same element is the explicit snap-back signal. `TugPromptInput`'s maximized editor opts in by default; other callers add the attribute to whatever element they want to be the source.

### User anchor capture

`TugSplitPane` attaches document-level capture-phase `pointerdown` / `pointerup` / `pointercancel` listeners. A `userDragActiveRef` is flipped on pointerdown when the target's closest `.tug-split-sash` is a direct child of this group's root, and cleared on pointerup. The ref is exposed to descendants via `UserDragContext`. `TugSplitPanel.onResize`:

- First fire: seed `userSetPctRef` from `size.asPercentage` (the library's resolved default).
- Later fires while `userDragActiveRef` is true: update `userSetPctRef`.
- All other fires (auto-size echoes, window rewraps that preserve percentage): leave the anchor alone.

No counters, no expected-size comparisons. The source of truth is the user's pointer.

### Persistence

Persistence is keyed off the pointer release event, not the library's `onLayoutChanged`. On pointerup after a user drag on a sash inside this group, `TugSplitPane` reads the group's layout via `GroupImperativeHandle.getLayout()` and PUTs it to tugbank under `storageKey`. Auto-size transients never reach storage because they never pass through a pointerup.

### Why echo loops stay out

- **MO** fires on subtree mutations. `panel.resize()` mutates `flex-grow` on the outer `[data-panel]` div — not in the MO subtree.
- **RO** observes `[data-panel]`'s contentBox; inline-size filter bails on the block-size changes from our own writes.
- `handleResize`'s anchor logic is gated on `userDragActiveRef`, which is false during our recompute — the library's async onResize echo lands with the flag false and is ignored.

### No animation

Every size change (grow, user drag, snap-back) is applied instantly via `panel.resize()`. A CSS transition on `flex-grow` would make drags laggy (the transition applies to the library's live drag updates too) and a programmatic animation would still have to fight the library's internal RO-based `onResize` sampling. The user explicitly preferred instant snap.

### Acceptance (validated in-app)

- Typing in the gallery card grows the panel past its default until `maxSize="85%"`.
- Submit clears the editor; panel snaps back to the user-dragged anchor (or default if undragged).
- Changing font size via the tools popover reflows the editor and the panel resizes to match — no explicit call.
- Resizing the window or card so the editor rewraps does not corrupt the user anchor (percentage is preserved).
- Dragging the sash is pixel-responsive — no lag from any transition or animation coupling.
- Auto-size values do NOT persist to tugbank; reload with a `storageKey` restores the last user-drag position, not the last content-driven size.
- No "ResizeObserver loop completed with undelivered notifications" warning.
- No "Group not found" error.
- No `requestAnimationFrame`, no `setTimeout`, no `queueMicrotask` in the sizing path.

### Law alignment

| Law    | How E complies                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| L02    | No external state pulled through `useSyncExternalStore` on the sizing path; imperative end-to-end            |
| L03    | Observer install in `useLayoutEffect`; pointer listeners in `useEffect` (they don't need pre-paint timing)   |
| L05    | No RAF                                                                                                       |
| L06    | No appearance state in React; every write goes through `panel.resize()` (imperative) or direct DOM           |
| L07    | `userSetPctRef`, `userSetSeededRef`, `lastWidthRef`, `panelElementRef`, `userDragActiveRef` — all refs        |
| L13    | No RAF, no CSS transition, no TugAnimator on the sizing path. Every change is instant.                       |
| L22    | DOM read (scrollHeight/offsetHeight) → DOM write (library imperative `resize()`). No React state round-trip. |
| L23    | `panel.resize()` preserves user-visible state (no DOM rebuild); library handles the write imperatively       |

### Delivery

Shipped across three commits:

- `0b2eacbb` — first pass at the observer skeleton. Had the echo-detection bug.
- `04d04a02` — reworked observer: source-query via `data-tug-auto-size-scroll-source`, instant snap, echo counter shared via context.
- Follow-up (below) — replaces the echo counter with pointer-event-based drag tracking; stores anchor as percentage; moves persistence to pointerup; documents the scroll-source contract in module docstrings.

### Out of scope (intentionally)

- Panels other than horizontal-sash. Vertical-sash wiring reads `scrollWidth` and filters on `blockSize`; same shape but not needed now.
- Multiple auto-sized panels in the same group. One anchor per panel; not coordinated across siblings.
- A callable `recomputeAutoSize()` imperative handle. The automatic signals cover every case we've identified; adding the escape hatch without a concrete caller invites speculative API.
- Shrink on partial delete. User-visible behavior: if you grow the pane by typing then delete most of the content, the pane stays grown until you submit (clearing the editor) or drag. This is by design; a future "size to fit" button or keyboard shortcut will be added as an explicit user action that is distinguishable from auto-resize.

---

## Track C — Content-driven panel sizing in TugSplitPane (superseded by Track E) {#track-c}

> ⚠️ **Superseded by Track E.** This section is preserved for history. Track C shipped in a working tree but was reverted before commit — see Track E for the reasoning and the replacement design.

**User directive (rev 2): the feature lives inside TugSplitPane. The card is a consumer that supplies inputs; it does not implement policy.** That flips my earlier recommendation. The card should be able to opt in with a prop or two and let the split pane do the work.

Scope: `tug-split-pane.tsx` (+ `.css`), with minimal opt-in from the consumer. `TugPromptInput` / `TugPromptEntry` remain unchanged by this track — the split panel observes the DOM directly.

### Goal

Adding a line to the input expands the input's rendered height; that expansion propagates upward through the entry to the split panel, causing the panel to grow toward `maxSize` and the sibling panel to shrink. When the user submits (input clears, scrollHeight collapses back), the sash **animates back to the user-set position**. The user-set position is remembered across typing sessions but not across page reloads unless `storageKey` is set.

### Sizing model (the rule in one line)

```
panel.currentSize = clamp( max(userSetSize, contentNeededSize), minSize, maxSize )
```

- `userSetSize` — the size the user last dragged the sash to. Defaults to `defaultSize`. Remembered for the panel's lifetime; persisted via `storageKey` when set.
- `contentNeededSize` — the natural size of the panel's content (from ResizeObserver).
- When content shrinks below `userSetSize`, the panel returns to `userSetSize` (animated, per requirement #5). This is the "prompt-by-prompt allowance": temporary expansion past `userSetSize`, automatic return afterward.
- When `contentNeededSize` exceeds `maxSize`, the content's own `overflow` (the input's `maximized` mode from Track B) scrolls internally.

### Proposed API

**C1. `TugSplitPanel` gains a content-observation prop.**

```tsx
interface TugSplitPanelProps {
  // ...existing...

  /**
   * Ref to an element whose `scrollHeight` (horizontal-sash pane) or
   * `scrollWidth` (vertical-sash pane) drives this panel's minimum
   * content-needed size. When set, the panel installs a `ResizeObserver`
   * on the element and resizes itself so the panel is at least as large
   * as the observed element, clamped by `minSize` / `maxSize`.
   *
   * The panel's `userSetSize` (from manual drags) is preserved — the
   * panel's effective size is `max(userSet, contentNeeded)` clamped to
   * the configured bounds. When content shrinks below `userSet`, the
   * panel animates back to `userSet`.
   *
   * The observation is DOM-driven [L22] — no React state is pulled
   * through `useSyncExternalStore` just to fire an imperative resize.
   */
  autoSizeFromRef?: React.RefObject<HTMLElement | null>;

  /**
   * Duration (ms) of the shrink-back animation when content shrinks
   * below `userSetSize`. Growth is immediate (no animation); only the
   * return-to-user-size transition animates. Set to 0 to disable.
   * @default 200
   */
  autoSizeReturnDuration?: number;
}
```

**C2. Gallery card wiring (tiny).**

```tsx
const editorRef = useRef<HTMLElement | null>(null);
// ...
<TugPromptEntry
  // (new in rev 2: expose the editor element through the existing delegate)
  inputMeasureRef={editorRef}
  ...
/>
// ...
<TugSplitPanel
  defaultSize="30%"
  minSize="15%"
  maxSize="85%"
  autoSizeFromRef={editorRef}
>
  { /* entry */ }
</TugSplitPanel>
```

One prop on the panel plus one ref thread — that's it. All policy lives in the panel.

**C3. Thin ref pass-through on `TugPromptEntry` / `TugPromptInput`.**

The split panel needs a ref to the element it's observing — concretely, the input's editor `<div>`. Options:

- **(C3a) Expose `inputMeasureRef` prop on TugPromptEntry** that forwards to TugPromptInput which attaches it to the editor element. Zero logic — it is a plumb-through ref. Pairs with the existing `getEditorElement()` method on the input delegate, but a ref is cheaper than imperative calls in this case because ResizeObserver needs the Node directly.
- **(C3b) TugSplitPanel accepts a `measureSource` that can be either a ref or a function returning a px number.** Lets the consumer use `() => entryDelegateRef.current?.getEditorElement()?.scrollHeight ?? 0` instead of wiring a ref. More flexible but adds a second contract.

**Recommendation: C3a.** One contract, law-aligned (the panel observes a DOM node directly — no callback round-trip).

**C4. Animation.**

- **Growth direction (expanding past userSetSize):** instant. Setting an interactive input taller as the user types should not visibly lag behind the keystrokes.
- **Shrink-back direction (returning to userSetSize):** animated over `autoSizeReturnDuration` ms.
- **Mechanism:** per [L13], use CSS `transition` on the library's resize hook if possible; fall back to [TugAnimator](../tugdeck/src/components/tugways/tug-animator.tsx) driving frame-by-frame calls to `panel.resize(pct)` with a cubic-ease curve. **Not** `requestAnimationFrame` directly [L13].
- **Accessibility:** respect `prefers-reduced-motion` — when the user prefers reduced motion, skip the transition and snap to `userSetSize`.

**C5. User-drag vs. content-driven sizing (C5c policy).**

- The panel observes the library's own layout-change events (already wired via `onLayoutChanged` inside TugSplitPane) to update its `userSetSize` ref whenever the user releases a drag.
- When content grows and forces the sash above `userSetSize`, the drag handle remains interactive — the user can still drag, and a drag mid-grow commits a new `userSetSize`.
- Persistence: when `storageKey` is set, `userSetSize` is saved via the existing tugbank channel. The content-driven instantaneous size is **not** persisted — only the user's anchor.

### What does NOT need to ship in Track C

- No new state in `TugPromptEntry` or `TugPromptInput`. They stay pass-throughs (C3 adds a thin ref prop).
- No new engine-level feature. The engine already surfaces editor `scrollHeight`; the split panel observes it directly via ResizeObserver.
- No changes to `CodeSessionStore`, the route indicator, the submit flow, or the toolbar.

### Resolved (rev 2) open questions

- **Where does policy live?** ✅ TugSplitPane/TugSplitPanel. Card just wires a ref + prop.
- **ResizeObserver performance?** ✅ Accept the risk; smoke-test as part of C1. Modern browsers coalesce RO callbacks off the main-thread paint cycle; a single observer on a single editor is negligible.
- **Persistence interaction?** ✅ Persist only `userSetSize`. Content-driven expansion is ephemeral and does not write to tugbank. On mount, read `userSetSize` via the existing `storageKey` path and use it as the anchor; first content observation may grow past it immediately.

### Remaining open questions

- **Chrome offset.** The ResizeObserver sees the editor's `scrollHeight`, but the panel needs to size itself to hold the editor *plus* the toolbar *plus* any entry padding. Two options:
  - (a) Consumer passes `autoSizeChromeOffset={px}` alongside the ref.
  - (b) Panel observes its whole content wrapper (so chrome is included automatically) but then needs a way to distinguish natural content height from stretch-to-fill height — not trivial when the content is `flex: 1`.
  - Leaning (a) — explicit and simple, even though it asks the consumer for one constant.
- **Multiple content sources.** What if a future card wants both panels content-driven? The current design assumes at most one content-driven panel per group (the library enforces a single anchor per drag). If we ever need multi-source, revisit — not a blocker for T3.4.b/c.

---

## Track D — File + command completion in the gallery card {#track-d}

### Rev 2 (shipped, history) {#track-d-rev2}

D1–D3 from rev 2 landed as part of the polish commit. `gallery-prompt-entry.tsx` today:

- Constructs a `FileTreeStore` (via `FeedStore` on `FeedId.FILETREE`) with a `workspaceKey` filter, exposing `@` completion via `fileTreeStore.getFileCompletionProvider()`.
- Constructs a `SessionMetadataStore` (via `FeedStore` on `FeedId.SESSION_METADATA`), exposing `/` completion via `store.getCommandCompletionProvider()`.
- Composes both into `completionProviders: Record<string, CompletionProvider>` — the generalized prop (D2b) is on the entry.
- Falls back silently (provider omitted) when `getConnection()` returns null.

The wiring mirrors `gallery-prompt-input.tsx` line-for-line; both cards share the `FileTreeStore` / `SessionMetadataStore` pair. There is no duplicated completion logic in the card — the stores own the snapshot + match semantics.

### Rev 3 (next — slash completion via captured `system_metadata`) {#track-d-rev3}

**What rev 3 actually is now.** An earlier draft of rev 3 proposed two commits: a hard-coded file fixture for `@` and a captured-metadata fixture for `/`. The `@` half was attempted and **rejected** (2026-04-17, see `bd5c48b1` "Align gallery-prompt-entry @ wiring with input card"). The gallery card already constructs a live `FileTreeStore` against the real connection-singleton, identical to `gallery-prompt-input.tsx`; replacing that with a Vite-enumerated path list was invented-complexity for a problem that didn't exist. The `@` story is done.

Rev 3 is therefore **one commit, one fixture, one trigger**: drive the gallery's `/` popup off the captured `capabilities/<LATEST>/system-metadata.jsonl` artifact that D6 lays down, instead of the live `SESSION_METADATA` feed.

**Why the `/` fixture is justified (and `@` wasn't).** The gallery card runs `CodeSessionStore` against a `MockTugConnection` — there is no real Claude Code session. The `SESSION_METADATA` payload Claude Code would emit on session start therefore never reaches the card, so the real `SessionMetadataStore` stays at its empty snapshot and the `/` popup opens blank. `FILETREE` is different: it's produced by tugcast independent of any Claude session, and the card's `FileTreeStore` goes through the real connection, so `@` works today.

**Directive (user, 2026-04-17):**
- Plugin skills/agents must load through the same `system_metadata` path Claude Code uses, not via one-off repo globs.
- Built-in commands must match the real Claude Code list (not a hand-imagined subset) — the captured `system-metadata.jsonl` in `capabilities/<LATEST>/` is the authoritative source.
- Tug.app always invokes Claude Code with an implicit `--plugin-dir tugplug` pointing at the bundle's resources, so the payload reflects tugplug's skills and agents.
- Agents should be invocable as slash commands. They're in `system_metadata.agents[]` today but the original UI parser dropped them — that gap is already closed (D5.a, `51880500`).
- Slash completion fires **only when `/` is the first character of the editor**. Anywhere else (mid-text, after whitespace) it stays a literal `/`.

**Invariant:** reuse the `CompletionProvider` contract and the engine's typeahead UI. Rev 3 does not touch `FileTreeStore`, the engine, `tug-prompt-entry.tsx`, or the live `@` path — only `gallery-prompt-entry.tsx` and one new fixture module. `SessionMetadataStore` itself is reused (not replaced) — the fixture swaps its feed-store source, not its parser.

#### D5 — `/` slash commands from captured `system_metadata`

**Scope:** two coordinated changes, one commit:

1. New fixture module `tugdeck/src/components/tugways/cards/completion-fixtures/system-metadata-fixture.ts` that feeds `SessionMetadataStore` from the captured `virtual:capabilities/system-metadata` artifact.
2. Rewire `gallery-prompt-entry.tsx`'s `completionProviders["/"]` onto the fixture store's provider, wrapped with the position-0 gate. Rip out the now-unused live `SessionMetadataStore` construction path in the gallery card.

Parser support for bare-string entries + `agents[]` + category-rank dedup already shipped (D5.a, see below).

##### D5.a — Close the `SessionMetadataStore` parser gap — SHIPPED

Shipped in commit `51880500` ("Accept bare strings + agents[] in system_metadata"). `tugdeck/src/lib/session-metadata-store.ts` now:

- Accepts both bare-string and `{ name, description?, category? }` entry shapes.
- Merges `slash_commands[]` (category `"local"`) + `skills[]` (category `"skill"`) + `agents[]` (category `"agent"`).
- Dedups by `name`, keeping the entry with the richer category via `CATEGORY_RANK = { local: 0, skill: 1, agent: 1 }` (first-writer-wins among equal-rank entries, which is fine — overlap is only local↔skill today).

This is **load-bearing for T3.4.c too** — a live session's slash popup would be empty without it.

##### D5.b — Load the captured `system_metadata` via the capabilities pipeline (D6 — SHIPPED)

The capabilities pipeline is already live. As of today (`eaa97156`, `2cddd1fb`, `96c5c9b2`):

- `capabilities/LATEST` contains `2.1.112` (no `v` prefix).
- `capabilities/2.1.112/system-metadata.jsonl` holds a single-line JSONL payload captured from real Claude Code 2.1.112.
- `virtual:capabilities/system-metadata` resolves at Vite build time to the raw JSONL string (see `capabilitiesVirtualModulePlugin` in `tugdeck/vite.config.ts`).
- The Xcode bundle copy step lays `system-metadata.jsonl` into `Tug.app/Contents/Resources/capabilities/`.

D5's fixture module is a thin wrapper over the virtual module:

```ts
// tugdeck/src/components/tugways/cards/completion-fixtures/system-metadata-fixture.ts
//
// The virtual module resolves to the raw JSONL contents of
// `capabilities/<LATEST>/system-metadata.jsonl`. We take the first line,
// JSON.parse it, and feed it to SessionMetadataStore via a stand-in
// FeedStore that emits once and stays silent.
import capturedJsonl from "virtual:capabilities/system-metadata";
import { FeedId, type FeedIdValue } from "@/protocol";
import { SessionMetadataStore } from "@/lib/session-metadata-store";

const fixturePayload = JSON.parse(capturedJsonl.split("\n")[0]);

/**
 * FeedStore stand-in that emits the captured system_metadata payload once on
 * first subscription, then stays silent. Same shape as the InertFeedStore
 * already present in gallery-prompt-entry.tsx; the one-shot emission is what
 * distinguishes this from the pure no-op.
 */
class FixtureFeedStore {
  private map: Map<FeedIdValue, unknown>;
  private listeners = new Set<() => void>();
  constructor() {
    this.map = new Map([[FeedId.SESSION_METADATA, fixturePayload]]);
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    // Synchronous delivery so SessionMetadataStore's constructor-time
    // _onFeedUpdate picks up the payload immediately.
    queueMicrotask(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.map;
}

let _store: SessionMetadataStore | null = null;

export function getFixtureSessionMetadataStore(): SessionMetadataStore {
  if (!_store) {
    const feed = new FixtureFeedStore() as never;
    _store = new SessionMetadataStore(feed, FeedId.SESSION_METADATA);
  }
  return _store;
}
```

Singleton scope is fine — the fixture is immutable and shared across mounts. Matches `gallery-prompt-input.tsx`'s `_cardServices` pattern.

**Tests to ship alongside:** a `system-metadata-fixture.test.ts` that reads the real `capabilities/<LATEST>/system-metadata.jsonl` (the virtual module has no bun-test shim — either mock it via `bun:test`'s `mock.module` or refactor the fixture into a pure `createFixtureStore(jsonl: string)` + thin wrapper). Counts to assert: 39 total slash commands, 16 of which are `category: "agent"`, 13 of which are `category: "skill"`, 10 of which are `category: "local"`.

##### D5.c — Position-0 gate for the `/` trigger

The engine's `detectTypeaheadTrigger` today activates on any trigger char after a whitespace boundary, so `/` mid-text would open an empty popup. The user's rule: **`/` is a slash command only at position 0.**

Two places to enforce:

- **(P1) Gate at the provider.** Wrap the fixture provider in a closure that reads the input's text via a delegate ref and returns `[]` unless the first character is `/`. Simple, self-contained, lives in the card. Engine still pops the menu when `/` is typed mid-text, but the menu is empty. Acceptable for D5 demo.
- **(P2) Gate at the engine.** Extend `TugPromptInput`'s `completionProviders` contract with a per-trigger config (e.g. `{ positionZeroOnly: true }`) so the engine doesn't activate typeahead at all when the rule fails. Cleaner for production; bigger scope; touches the engine.

**Recommendation: P1 for D5** (unblock the gallery now), then promote to P2 as part of T3.4.c when we wire the live session — the constraint has to hold in production, not just the gallery.

Gate implementation:

```ts
function wrapPositionZero(
  inputRef: React.RefObject<TugPromptEntryDelegate | null>,
  inner: CompletionProvider,
): CompletionProvider {
  return (query: string) => {
    const editor = inputRef.current?.getEditorElement();
    const text = editor?.textContent ?? "";
    if (text.length === 0 || text[0] !== "/") return [];
    return inner(query);
  };
}
```

Use `entryDelegateRef` (already in the card for content-driven sizing) as the source — no new refs.

##### D5.d — Wire into the gallery card

```ts
const completionProviders = useMemo(() => {
  const out: Record<string, CompletionProvider> = {};
  out["@"] = createFileFixtureProvider();
  const innerSlash = getFixtureSessionMetadataStore().getCommandCompletionProvider();
  out["/"] = wrapPositionZero(entryDelegateRef, innerSlash);
  return out;
}, []);
```

The backend-backed `SessionMetadataStore` wiring in the card (currently live) is no longer plumbed into `/`. Recommend **rip it out** during this commit — the fixture store is the only source the gallery should use, and dead code reads confusingly. T3.4.c re-adds the live wiring against the real session.

**Acceptance (D5, against the shipped v2.1.112 artifact):**
- Type `/` as the first character of the gallery entry; popup lists **39 entries** deduped from the captured `system_metadata`:
  - **23 slash_commands** — 13 of which upgrade to `category: "skill"` via the overlap merge (`batch`, `claude-api`, `commit`, `debug`, `less-permission-prompts`, `loop`, `schedule`, `simplify`, `tugplug:dash`, `tugplug:implement`, `tugplug:merge`, `tugplug:plan`, `update-config`), 10 remain `category: "local"` (`compact`, `context`, `cost`, `extra-usage`, `heapdump`, `init`, `insights`, `review`, `security-review`, `team-onboarding`).
  - **16 agents** — `Explore`, `Plan`, `general-purpose`, `statusline-setup`, plus 12 `tugplug:*-agent` entries (`architect`, `auditor`, `author`, `clarifier`, `coder`, `committer`, `conformance`, `critic`, `dash`, `integrator`, `overviewer`, `reviewer`).
- Type `/tug`; narrows to the 16 `tugplug:`-prefixed entries (4 skills + 12 agents).
- Type `/com`; narrows to `commit`, `compact`, `tugplug:committer-agent` (3 hits — `tugplug:conformance-agent` does NOT match because its second syllable is `con-f`, not `com`).
- Accept a result; a command atom lands in the editor carrying the fully-qualified name.
- Type a character **other than `/`** as the first character, then a `/` mid-text: popup does NOT open (or opens empty — P1 allows the trigger to fire; the wrapper returns `[]`).
- Submit the editor; route stays on `>` (Prompt) — this card doesn't use the `:` Command route.
- No backend round-trip, no warning about missing `SESSION_METADATA` feed.

**Out of scope for D5:**
- Terminal-only commands (`/status`, `/model`, `/clear`, `/vim`, `/btw`, `/resume`). They're not in `system_metadata.slash_commands` per transport-exploration.md line 1194. Follow-on work in `tide.md` handles responding to those when the graphical UI reimplements them.
- Category-aware styling (different badge for skill vs agent vs local). The popup stays name-only; `category` survives on the snapshot for a later pass.
- Promoting the position-0 gate to the engine (P2). T3.4.c.
- Re-capturing the artifact when Claude Code rolls (2.1.113+). Lives in D6's runbook, not here.
- Auto-invoking agents through a real dispatcher — today they're completion-only; invocation remains a T3.4.c / tide.md concern.

---

## Track F — Capabilities artifact pipeline {#track-f}

### D6 — Build-time capabilities discovery {#d6}

**Status (2026-04-17):** D6.a / D6.b / D6.c / D6.e shipped across `eaa97156`, `2cddd1fb`, `96c5c9b2`, `11091c6a`. D6.d (Swift-side mismatch bulletin) is the only piece still outstanding and is not a blocker for D5.

**Directive (user, 2026-04-17):**
- **Build-time only.** The extraction must not run on Tug.app's launch path. A developer / CI action produces a committed artifact; the app loads that artifact at startup.
- **General, not test-named.** The captured payload lives under a product-facing name (`system-metadata.jsonl`) in a well-known location — not behind a `test-28-system-metadata-deep-dive.jsonl` path inside the tugcast test catalog.
- **Well-known bundle path.** Both dev builds (`bun dev` against the tugdeck source tree) and production builds (Tug.app with tugdeck / tugcast bundled as resources) must be able to locate the artifact at a consistent path.
- **`capabilities/LATEST` pointer.** The pointer is versioned alongside the payload so the build picks up whichever snapshot the pointer resolves to. Version bumps update the pointer as part of the rotation runbook.
- **Mismatch handling at runtime.** The app uses the best-available baked snapshot. When the live `system_metadata.version` (observed on first session start) disagrees with the baked one, post a **tug-bulletin** to notify the user that the slash-command list may be stale.

D6 is the load-bearing prerequisite for D5: D5 consumes the artifact D6 produces. Ship D6 first.

#### D6.a — Capture pipeline extension

The golden-catalog capture rig already drives Claude Code through the probe-28 "system-metadata deep dive" scenario and normalizes the output into `tests/fixtures/stream-json-catalog/v<ver>/test-28-system-metadata-deep-dive.jsonl`. That file is six lines — `session_init`, `system_metadata`, a user turn, and stream close — with the normalizer's `{{uuid}}` / `{{cwd}}` / `{{iso}}` placeholders applied.

Add a new extraction step to the capture pipeline (runs as part of the same `cargo` / `bun` invocation the version-bump runbook already uses):

1. Read the just-captured probe-28 file.
2. Extract the single line whose parsed JSON has `type === "system_metadata"`.
3. Write that line verbatim (still with placeholders — the UI's fields are `version`, `slash_commands`, `skills`, `agents`, `plugins`, none of which are templated) to:

   ```
   <repo-root>/capabilities/v<ver>/system-metadata.jsonl
   ```

4. Update `<repo-root>/capabilities/LATEST` to contain the single version string (e.g. `v2.1.105\n`).

Implementation note: a Rust `extract_capabilities()` helper invoked after the probe writes its fixture keeps the change within the tugcast crate — no new binary, no new CI job. Alternatively a tiny `bun run scripts/extract-capabilities.ts` on the tugdeck side can read the jsonl and write the output. Recommend **Rust-side** because the rest of the capture path is there; colocation keeps the version-bump runbook a single operation.

#### D6.b — Repository layout

```
<repo-root>/
  capabilities/
    LATEST                             # text file: "2.1.112\n" (no "v" prefix)
    README.md
    2.1.105/
      system-metadata.jsonl            # normalized single-event capture
    2.1.112/
      system-metadata.jsonl
```

- **Versions retained.** Same policy as the stream-json catalog — cheap (one small JSONL per version), useful for reproducing historical UI behavior or bisecting slash-command regressions.
- **`LATEST` is a text file, not a symlink.** Portable on every host OS; readable by both Vite's Node-side build and Xcode's resource-copy phase without shelling out.
- **No `v` prefix on version strings.** Matches Claude Code's `--version` output verbatim. The shipped plugin + Xcode build-phase both read `LATEST` via `tr -d '[:space:]'` and concatenate `capabilities/<ver>/system-metadata.jsonl`.
- **No JSONL→JSON trim.** The payload stays JSONL (one event per line, matching the catalog's native format) so downstream tooling can consume it with the same parsers.

#### D6.c — Bundle placement

Two build environments consume the artifact; both need a stable path:

- **tugdeck (Vite / browser bundle).** A Vite plugin (or `define` substitution) resolves `import "virtual:capabilities/system-metadata"` at build time by reading `<repo-root>/capabilities/LATEST`, then the corresponding `v<ver>/system-metadata.jsonl`. Returns the file contents as a raw string that the consumer `JSON.parse`s on the first line. One import site, one virtual module — no loose asset paths.
- **Tug.app (Xcode / Swift).** The `.xcodeproj` gains a pre-build phase that reads `<repo-root>/capabilities/LATEST` and copies the resolved file to `Tug.app/Contents/Resources/capabilities/system-metadata.jsonl`. The Swift host loads it at startup via `Bundle.main.url(forResource:withExtension:subdirectory:)`. The filename inside the bundle is the version-neutral `system-metadata.jsonl` — the specific version is embedded in the payload's `version` field.

Both environments therefore converge on the same canonical filename (`system-metadata.jsonl`), while the repository keeps the versioned layout for history.

#### D6.d — Runtime version mismatch → tug-bulletin

The Swift host doesn't probe Claude Code on launch (per directive — no extra startup cost). Instead, it waits for the first real session to produce its own `system_metadata` frame, then compares:

```
let baked   = loadBakedSystemMetadata().version   // e.g. "2.1.105"
let observed = firstSystemMetadataFrame.version   // e.g. "2.1.112"

if baked != observed {
  TugBulletin.post(
    kind: .capabilitiesStale,
    title: "Slash commands may be out of date",
    body: "Baked capabilities snapshot is \(baked); Claude Code is \(observed). Rebuild Tug.app to refresh.",
  )
}
```

One bulletin per launch — deduped on the same `(baked, observed)` pair so session restarts within the same launch don't spam. This check is advisory; the baked snapshot keeps driving the UI regardless.

**Open question (small):** does the project already have a `TugBulletin` surface exposed to Swift, or is this the first Swift-side poster? If no precedent exists, fall back to a console `os_log` in the D6 commit and note the bulletin wiring as a follow-up. (The directive implies bulletins exist; confirm at implementation time.)

#### D6.e — Runbook tie-in

The version-bump runbook in `dash/tugplan-golden-stream-json-catalog.md#deep-version-bump-runbook` gets two new steps appended after the existing probe-rerun step:

1. Run the capabilities extraction (the new step from D6.a).
2. Update `capabilities/LATEST` to point at the new version string.

Both steps are mechanical; they belong in the runbook rather than as a standalone document.

#### D6.f — What D5 needs from D6

- Resolvable path: `virtual:capabilities/system-metadata` (tugdeck).
- Single-line JSONL at that path whose parse-result is a `system_metadata` payload.
- `version` field inside the payload (used for mismatch check in the Swift host; also handy for the fixture to log at dev time).

Nothing else — no helper utilities, no re-export of `SessionMetadataStore`, no typed wrapper. D5 owns the parse-and-mount; D6 owns the capture-and-placement.

**Acceptance (D6):**
- Run `just capture-capabilities`. `capabilities/<ver>/system-metadata.jsonl` appears; `capabilities/LATEST` reads `<ver>` (no `v` prefix). *(Shipped — validated against 2.1.112.)*
- `bun run build` in tugdeck produces a bundle that contains the payload inlined (verify: grep the built output for `tugplug:plan` → present). *(Shipped.)*
- `xcodebuild -project Tug.xcodeproj` copies `system-metadata.jsonl` into `Tug.app/Contents/Resources/capabilities/`. *(Shipped — see `tugapp/Tug.xcodeproj/project.pbxproj` copy phase.)*
- A first session under a matching Claude Code version produces no tug-bulletin. *(Pending D6.d.)*
- A first session under a mismatching Claude Code version produces one tug-bulletin, with the baked + observed version strings. *(Pending D6.d.)*

**Out of scope for D6:**
- **Runtime probing on launch.** Directive explicitly excludes it.
- **Live refresh of the baked snapshot.** Users rebuild Tug.app to pick up a new capabilities version; no in-app "update capabilities" flow.
- **Anything beyond `system_metadata`.** Other `system_metadata`-adjacent feeds (cost updates, compact boundaries, etc.) stay in the live session path. D6 is specifically the capabilities surface the slash-popup needs.
- **Dropping the test-catalog fixture.** The stream-json catalog keeps its probe-28 file for drift regression; the new `capabilities/` tree is a second output, not a replacement.

---

## Delivery order and rough sizing

| #  | Track | Change                                                                          | Size | Risk | Status             |
|----|-------|---------------------------------------------------------------------------------|------|------|--------------------|
| 1  | A1    | `showHandle` prop on `TugSplitPane`                                             | XS   | Low  | Shipped            |
| 2  | A2+A3 | Gallery card uses `maxSize="85%"` + `showHandle={false}`                        | XS   | Low  | Shipped            |
| 3  | B1+B2+B3 | Entry fills + toolbar pinned + input `maximized`                             | S    | Low  | Shipped            |
| 4  | B4    | Remove outer border + update pairings                                           | S    | Low  | Shipped            |
| 5  | B5+B6 | Gallery wrapper as `TugBox inset={false}`                                       | XS   | Low  | Shipped            |
| 6  | D1    | Wire real `fileCompletionProvider` in gallery card                              | XS–S | Low  | Shipped            |
| 7  | D2b   | Generalize entry's completion prop → `completionProviders` map                  | S    | Low  | Shipped            |
| 8  | E1    | Replace Track C's props/impl: `TugSplitPanel.autoSize` + `autoSizeReturnDuration` | S | Low | Shipped (Track E) |
| 9  | E2    | MO + RO install on panel's inner wrapper; `recompute` unifies all fires         | M    | Med  | Shipped (Track E)  |
| 10 | E3    | CSS rule + `--auto-size-transition-duration` write path                         | XS   | Low  | Shipped (Track E)  |
| 11 | E4    | Remove `measureRef` from `TugPromptEntry` / `TugPromptInput`; simplify card     | XS   | Low  | Shipped (Track E)  |
| 12 | D4    | ~~`@` file completion fixture for gallery~~                                     | —    | —    | Rejected (2026-04-17) |
| 12.5 | D1b | Align `gallery-prompt-entry` `@` wiring with `gallery-prompt-input`             | XS   | Low  | Shipped (`bd5c48b1`) |
| 13 | D6.a  | Capture pipeline extension: write `capabilities/<ver>/system-metadata.jsonl`    | S    | Low  | Shipped (`eaa97156`) |
| 14 | D6.b+c | `capabilities/` + `LATEST` layout; Vite virtual module; Xcode bundle copy      | S    | Med  | Shipped (`2cddd1fb` + `eaa97156`) |
| 15 | D6.d  | Swift-side mismatch check + tug-bulletin on first `system_metadata` frame       | XS   | Low  | Next (non-blocker) |
| 16 | D6.e  | Runbook tie-in — append extraction step to version-bump runbook                 | XS   | Low  | Shipped (`11091c6a` + `96c5c9b2`) |
| 17 | D5.a  | `SessionMetadataStore` parser: bare strings + `agents[]` + category-rank dedup  | XS   | Low  | Shipped (`51880500`) |
| 18 | D5.b–d | `/` slash-command completion in gallery via capabilities artifact + position-0 gate | S | Low | **Next (unblocked)** |
| ~~C1–C5~~ | | ~~Track C variants~~ — **superseded by Track E.** See §Track E.                       |      |      | Reverted           |

**Commit grouping:**
- **Commit 1 — Polish:** items 1–7 (Track A + B + D rev 2). Pure layout, visibility, and wiring. *Shipped in `652ed1d5`.*
- **Commit 2 — Content-driven sizing:** items 8–11 (Track E). *Shipped.*
- ~~**Commit 3 — `@` fixture (D4):**~~ *Rejected 2026-04-17. D4 substituted the card's working live `FileTreeStore` for a static path-list; this was wrong. Item 12.5 (`bd5c48b1`) keeps the live watcher and aligns the entry card's wiring with the input card's.*
- **Commit 4 — Capabilities pipeline (D6):** items 13, 14, 16. *Shipped across multiple commits listed above.*
- **Commit 5 — `/` slash completion (D5):** item 18. Self-contained single commit — consumes the already-shipped `virtual:capabilities/system-metadata`, spins up the fixture `SessionMetadataStore` via a one-shot FeedStore, adds position-0 gate, rewires the gallery card's `/` provider, rips out the no-longer-needed `InertFeedStore` + live `SessionMetadataStore` construction in the card.
- **Follow-up — D6.d:** item 15. Swift-side launch-time mismatch bulletin. Independent of D5.

## Tests

- **Track A:** snapshot the gallery card; confirm `.tug-split-sash-handle` is not in the DOM (or is `display: none`). Unit: `showHandle={true}` default keeps the pill.
- **Track B:** rendering test — entry root has no `border` computed style; entry + toolbar both render; input's wrapper has `data-maximized`.
- **Track E:** no automated tests. The sizing path is observer-driven and happy-dom's `MutationObserver` stores its callback in a `WeakRef` that bun's GC collects between mutations, breaking multi-step scenarios. Rather than ship tests that prove nothing, this track is validated in the running app against the gallery card's acceptance criteria (typing grows the panel, submit animates back, font-size change resizes, no browser warnings).

## Out of scope

- **Transcript / message-list surface in the top pane.** That's T3.4.c's territory; this plan leaves the top panel empty.
- **Re-wiring the existing `growDirection="up"` prop.** The prop stays untouched; Track E works independently of it (though it reads nicest with `growDirection="up"` so the input's top edge rises while the bottom stays anchored to the toolbar).
- **Sash persistence.** Whatever `storageKey` behavior the gallery card picks is its own choice; this plan does not add or remove it.

## Where to land

- New work lives on `main` (no worktree needed per current workflow).
- Commits are small-batched by track: one "polish" commit for Tracks A + B + D (shipped), one "content-driven sizing" commit for Track E.
- No migration / feature flag — the component's caller set is small enough (gallery card + forthcoming Tide card) that changes apply to all callers immediately.

---

## Appendix — Tuglaws compliance review {#law-review}

User asked for an explicit check against [tuglaws.md](../tuglaws/tuglaws.md) for the content-driven sizing approach. Verdict: compliant, with implementation guardrails listed below.

| Law | Applies? | How this plan complies |
|---|---|---|
| **L01** one root.render | Indirect | No change — everything routes through the existing `root.render` at app mount. |
| **L02** external state via `useSyncExternalStore` | **Yes, and deliberately avoided** | Panel size is DOM-observable external state. We do **not** pull it through `useSyncExternalStore` to render against it — that would force a React commit on every `scrollHeight` tick, which is exactly what L22 warns against. The panel observes the DOM directly and imperatively calls the library's `resize()`. `storageKey`-persisted `userSetSize` *is* read via `useSyncExternalStore` (that path already exists in `TugSplitPane`) because it drives a React-owned prop (`defaultSize`); the content-driven tick does not. |
| **L03** useLayoutEffect for event-dependent registrations | **Yes** | The `ResizeObserver` install happens in `useLayoutEffect` so the observer is wired before the first paint can fire a size event. Same pattern the split pane already uses for its library-handle ref. |
| **L04** never measure child DOM inline after child setState | N/A | No parent effect triggers a child `setState` here. The DOM measurement is always done asynchronously by the RO callback. |
| **L05** no RAF for React-state-dependent ops | **Yes** | The shrink-back animation is driven by CSS transition or TugAnimator (see C4). No `requestAnimationFrame` inside the sizing loop. |
| **L06** appearance state in DOM, not React | **Yes** | Panel size is *data* by the L06 test ("does any non-rendering consumer depend on this state?" — yes: persistence, drag handlers, and the content-driven resize policy all consume it). Data is allowed to flow through React when needed. The ephemeral *mid-transition* size while the shrink animation runs is appearance — no React state update for it; the animation writes directly. |
| **L07** handlers read current state via refs | **Yes** | The panel stores `userSetSize`, `maxSize`, `minSize`, the library's `PanelImperativeHandle`, and the content-source element in refs. The RO callback reads all of them via refs — no stale closure. |
| **L08** mutation-transaction zone rules | Partial | The drag interaction is already a *continuous* control (every intermediate size is committed) — L08 does not apply to it per the law's "continuous controls" carve-out. The content-driven resize is likewise a continuous write — no draft/commit split. |
| **L09 / L10** card chrome vs card content | N/A | Not a card-level change. |
| **L11** controls emit, responders own state | **Declared exempt** | TugSplitPane already declares itself L11-exempt in its module docstring ("TugSplitPane is a layout primitive, not a control"). Adding content-driven sizing stays inside that carve-out — it is still a layout primitive, the callback-free. |
| **L13** CSS / TugAnimator / RAF carve-outs | **Yes** | Shrink-back animation goes through CSS transition first, TugAnimator as a fallback. No RAF. Reduced-motion respected. |
| **L15–L18, L20** token laws | **Yes** | Any new CSS (the `showHandle={false}` rule, the border removal on `.tug-prompt-entry`) stays within the existing split-pane / prompt-entry token slots. No cross-component token reach-ins. Pairings get updated where the declarations change (Track B's border removal; any new handle-visibility rule has no color declaration so no `@tug-pairings` change needed). |
| **L19** component authoring guide | **Yes** | New props (`showHandle`, `autoSizeFromRef`, `autoSizeReturnDuration`) follow the existing TugSplitPane prop style: JSDoc, `@selector` / `@default` tags, data-attribute mirroring where visual. |
| **L20** composed children keep their tokens | **Yes** | `TugPromptEntry`-in-`TugSplitPanel` composition is unchanged; neither reaches into the other's tokens. |
| **L21** third-party licensing | N/A | No new dependency. `react-resizable-panels` is already in use. |
| **L22** direct DOM updates observe the store, not React-state round-trip | **Yes, primary law governing this design** | The `ResizeObserver` → `panel.resize()` path is exactly the DOM-driven observer pattern L22 endorses. We do **not** pull the content height into React state via `useSyncExternalStore` just to trigger a resize — that would inject React's scheduling (re-render → paint → effect) between the content change and the resize call, producing exactly the kind of frame delay L22 warns about. |
| **L23** internal ops preserve user-visible state | **Yes** | The resize never clobbers scroll position, selection, or focus. The library's `resize()` preserves the underlying DOM; our content observer does not rebuild or remount anything. User's drag-set anchor is preserved across every content tick (that is the whole point of the sizing model). |

**Implementation guardrails (carry forward into the coder's step):**

1. `ResizeObserver` install site: `useLayoutEffect`, empty deps aside from the ref contents — subscribe once per panel lifetime.
2. Policy params (`userSetSize`, `maxSize`, `minSize`, panel handle, source ref) live in refs. No closures over React state.
3. The resize call path is purely imperative: RO callback → compute target pct → `panelHandle.current?.resize(pct)`. No React setState on this path.
4. The shrink-back animation uses CSS `transition` on a declarative property the library honors, or TugAnimator driving a target value. **Never** `requestAnimationFrame` inside the plan's sizing code.
5. Persistence writes only happen in the existing `handleLayoutChanged` path (user drag released), not in the content-driven RO callback.
6. Tests cover the ref-based observer path end-to-end with a fake `ResizeObserver` shim so there is no happy-dom flakiness.

### Specific answer to "does `onDesiredHeightChange` comply with tuglaws?"

Under the rev-2 architecture, `onDesiredHeightChange` **no longer exists**. The pivot to "TugSplitPane owns the feature" eliminated the callback. That was the right call on L22 grounds: the callback design routed a DOM-observable signal through user-space React callbacks before re-entering the DOM as an imperative resize. The new architecture keeps the entire observation → resize loop inside the panel's own DOM-driven subsystem, which is exactly the L22 shape.

If we had kept the callback approach, it would have been *defensible* but awkward: the consumer would have had to use refs (L07) and useLayoutEffect (L03) and keep the callback off the React render path (L22), which is a lot of ceremony to put on every consumer. The panel-owns-it design makes the law-compliant path the default.
