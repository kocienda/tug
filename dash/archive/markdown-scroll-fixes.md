# Markdown Scroll Fixes

Two architectural problems in TugMarkdownView cause visible scroll jank during
streaming and degrade performance as documents grow.

## Problem 1: O(n²) full rescan on every streaming chunk

### Diagnosis

Every streaming chunk triggers `doSetRegion('stream', accumulatedText)` which
calls `incrementalUpdate()`. Despite the name, `incrementalUpdate` re-lexes the
*entire* document on every call:

```
incrementalUpdate(engine, text)
  → lex_blocks(text)              // WASM: scans all bytes, not just new ones
  → buildByteToCharMap(text)      // allocates Uint32Array(byteLength + 1)
  → newBlocks.map() × 2          // two full passes over all blocks
  → diff loop over all old blocks // compares start/end for every existing block
```

With N streaming chunks arriving over the life of a document, and the document
growing by ~200 chars per chunk, the total work is proportional to:

    200 + 400 + 600 + ... + 200N = O(N²)

At 1MB of accumulated text (~5,000 chunks), each chunk re-lexes the full
megabyte, rebuilds a million-entry byte-to-char map, and diffs thousands of
blocks. This is why the gallery card's lex timing climbs steadily during a
stream.

### Stable parse boundary

A **stable parse boundary** is a position in the document where every block
before that position is **closed** — its type, content, and structure are final
and cannot be changed by any content change after the boundary — and every
block after that position is unaffected by any content change before the
boundary.

The boundary works in both directions. Given an edit at some position in the
document, we need a stable boundary *before* the edit (so we know how far back
to re-lex) and implicitly one *after* it (so we know when re-lexed blocks
have converged with the old block stream and we can stop).

#### Definition

A stable parse boundary exists at a blank-line position (`\n\n`) in the
document when **all** of the following are true:

1. **No unclosed fenced code block spans across it.** A fenced code block
   opens with `` ``` `` (or `~~~`) and closes with a matching fence. Until the
   closing fence arrives, *all* subsequent content is code — the boundary
   cannot exist inside an open code fence. To verify: count opening and closing
   fences from the start of the document (or from the last known-good boundary)
   forward. If the count is balanced, we're outside a code fence.

2. **No unclosed HTML block spans across it.** CommonMark HTML blocks (types
   1-7) have varying termination rules, but all are terminated by a blank line
   except type 6 and 7 which also end on blank lines. Conservatively: if the
   content before the blank line ends with an unclosed `<pre>`, `<script>`, or
   `<style>` tag (HTML block types 1), treat the boundary as unstable.

3. **The blank line is not preceded by a setext heading underline candidate.**
   A line of `===` or `---` immediately after a paragraph turns it into a
   heading. But a blank line *before* such a line prevents this — so a blank
   line followed by another blank line (or by a non-paragraph block) is safe.
   Conservatively: the boundary must be at a blank line that is followed by at
   least one more line (the new content), not by `===` or `---`. In practice,
   streaming chunks never start with a setext underline.

#### Region boundaries are parse boundaries

`RegionMap` joins regions with `\n\n`. That double newline is itself a parse
boundary — it closes paragraphs, ends lists, terminates blockquotes. The only
construct that can span across a `\n\n` is an unclosed fenced code block.

This means **a `setRegion` call cannot invalidate blocks in other regions** —
unless the edited region has an unbalanced fence (an opener without a closer,
or vice versa) that changes whether subsequent regions are inside or outside
a code block. In all other cases, the `\n\n` between regions is a firewall.

**Balanced fences (common case):** The edit is contained. Re-lex only the
edited region. Blocks in preceding and following regions are untouched.

**Unbalanced fence (rare case):** The edit opened or closed a fence that
wasn't matched before. This changes the parse context for subsequent regions.
Re-lex forward from the edited region until fences re-balance. In the worst
case (a single unclosed fence), this means re-lexing to the end of the
document — but this is genuinely rare in practice and correct behavior.

#### Scoping the re-lex to the edited region

Because region boundaries are parse boundaries (modulo the fence caveat), the
re-lex window for a region edit is:

- **Backward boundary:** The start of the edited region. No need to scan
  further back — the `\n\n` before the region is the firewall. (Within the
  region, we could scan backward to find an earlier stable boundary, but
  regions are typically small enough that re-lexing the whole region is fine.)

- **Forward boundary:** The end of the edited region, unless fences are
  unbalanced after the re-lex. If balanced, stop. If unbalanced, continue
  into subsequent regions until balance is restored.

- **Blocks before the edited region:** Frozen. Don't touch.

- **Blocks after the edited region (balanced case):** Content is unchanged,
  but block *indices* may shift if the edit changed the number of blocks in
  the edited region. This is an index renumbering, not a content change —
  the HTML cache and height data are still valid, just at different indices.

#### The block index splice

If an edited region previously produced `P` blocks and now produces `Q`:

- **P == Q:** Overwrite blocks in place. No renumbering needed.
- **P != Q:** Splice the block arrays. Shift all subsequent block indices by
  `Q - P`. The height index entries and HTML cache entries for subsequent
  blocks need their keys remapped, but their values are unchanged.

This is the one operation that touches blocks outside the edited region — but
it's a mechanical index shift, not a re-lex or re-parse. It's O(number of
subsequent blocks) in the worst case, but only touches array indices and map
keys, not content.

#### Conservative simplification

**Fence counting:** Walk forward from the start of the document (or from the
last cached fence-count position) counting lines that match the fenced code
block opening/closing pattern (`` ``` `` or `~~~`, with optional info string
for openers). Track whether we're currently inside a fence. Cache this state
per region boundary so we don't re-walk the entire document on every update.

**Fallback:** If no stable boundary is found (e.g., the entire document is
one giant open code fence), the boundary is position 0 — re-lex everything.
This is the current behavior, so it's no worse than today. It only happens
for pathological content (an unclosed code fence spanning the entire stream).

**The boundary doesn't need to be byte-perfect.** The goal is to defeat the
O(n²) pathology, not to minimize the re-lex window to the exact byte. If the
boundary is a few blocks earlier than theoretically possible, we re-lex a few
extra blocks — kilobytes, not megabytes. Our WASM lexer handles kilobytes in
sub-millisecond time. Being conservative is fine.

#### What we skip vs. what we redo

Given a region edit where the edited region spans blocks `S..S+P-1`:

- **Blocks 0..S-1:** Frozen. Block metadata, height estimates, and cached HTML
  are all valid. Don't touch them.
- **Blocks S..S+P-1:** Re-lex, re-parse, re-cache. After the re-lex, the
  region may produce a different number of blocks `Q`.
- **Blocks S+P..end:** Frozen content. If `P != Q`, renumber indices by
  shifting `+(Q-P)`. Height data and HTML cache values are valid; only the
  keys change. If fences are unbalanced after the re-lex, continue re-lexing
  into these regions until balance is restored.

For **tail appends** (the streaming path): `S` is near the end of the
document, the "frozen suffix" category is empty, and no index renumbering
is needed. This is the fast path and the most common case.

### Proposed fix: incremental lexing with stable parse boundaries

**Strategy:**

1. **Track per-region block ranges and fence state in the engine.** Add to
   `MarkdownEngineState`:
   - `regionBlockRanges: Map<string, { start: number; count: number }>` —
     maps each region key to the block index range it produced
   - `regionFenceBalance: Map<string, number>` — net fence depth change per
     region (0 = balanced, +1 = opened a fence, -1 = closed one)

   These are rebuilt on full rebuild (`lexParseAndRender`) and updated
   incrementally on region edits.

2. **On region edit, scope the re-lex to that region.** Look up the region's
   previous block range (`start: S, count: P`). Extract the region's new text
   from `RegionMap`. Lex only that text: `lex_blocks(regionText)`. The WASM
   lexer returns byte offsets relative to the region slice; add the region's
   byte offset in the full document to get global offsets.

3. **Build byte-to-char map for the region slice only.** Call
   `buildByteToCharMap(regionText)`. Add the region's char offset to get
   document-global char indices.

4. **Check fence balance.** Count fences in the re-lexed region. If the net
   balance changed from the previous lex of this region, the edit affects
   subsequent regions — continue re-lexing forward region by region until
   the cumulative fence balance returns to what it was before the edit.
   (Common case: balance is 0 before and after. No forward propagation.)

5. **Splice the block arrays.** The old region produced `P` blocks starting
   at index `S`. The new lex produced `Q` blocks. Replace blocks `S..S+P-1`
   with the `Q` new blocks. If `P != Q`, shift all subsequent block indices
   by `+(Q-P)`: update `regionBlockRanges` for later regions, and remap
   keys in `htmlCache`, `heightIndex`, and `blockNodes`.

6. **Update height index and HTML cache for re-lexed blocks only.** For the
   `Q` blocks in the edited region:
   - Parse each to HTML via `parse_to_html` and store in `htmlCache`.
   - Compute estimated height and store in `heightIndex`.
   - If a DOM node exists for a changed block, update its innerHTML.

7. **Rebuild the visible window** from the current scroll position, same as
   today.

**Streaming fast path (tail append):** When the edited region is the last
region (the `'stream'` key), there are no subsequent regions to shift. Step 4
is a no-op (no downstream regions). Step 5 has no suffix to renumber. The
only work is: find the backward boundary within the region (latest `\n\n`
with balanced fences), lex from there, parse new/changed tail blocks, append
to height index and cache. This is O(new content) per chunk, O(N) total.

**Middle-region edit:** Re-lex the region (typically small), splice the block
index space, remap suffix indices. No re-lex of other regions unless fences
are unbalanced. O(region size + suffix block count for renumbering).

**WASM changes:** None required. `lex_blocks` already accepts any string. We
pass region-sized slices instead of the full document.

**What triggers a full rebuild:** `removeRegion` (removing a region from the
middle changes all subsequent offsets and may merge adjacent regions), `clear`,
or any corruption of the tracked state. The full rebuild path
(`lexParseAndRender`) remains as the safe fallback.


## Problem 2: Two-phase scroll update ("womp womp")

### Problem 2a: lexParseAndRender destroys user state

**Principle:** The user's scroll position is *their* data. They put it
there. It represents what they are looking at. Internal implementation
operations — re-lex, re-parse, block index rebuild — must never be
visible to the user. The scroll position, whether follow-bottom is
engaged, and what content is visible must be invariant across any
internal rebuild operation.

`lexParseAndRender` violates this principle. It:

1. Saves `scrollTop` (acknowledging it's about to destroy it)
2. Clears all block nodes, sets spacers to 0 — scroll container now
   has zero content height
3. Re-lexes, re-parses, rebuilds blocks
4. Attempts to restore `scrollTop` from estimated heights

This is data loss with a flawed recovery path. Between step 2 and
step 4, the scroll container has no content. The browser clamps
`scrollTop` to 0. Scroll events may fire. SmartScroll may interpret
the position change as user action and disengage follow-bottom. The
restoration in step 4 uses estimated heights that don't match reality.

The "save and restore" pattern is the wrong approach entirely. The
right approach: **don't destroy the state in the first place.**

**Repro:** Load 10KB static in the gallery card. Scroll up so the
scroll thumb is mid-document. Load 1KB static. The scroll jumps to the
top instead of staying near where it was.

**Fix:** Lift the D03 restriction from Problem 1. `incrementalTailUpdate`
already does region-scoped lex, block splice, and fence propagation for the
tail region. The only reason non-tail regions fall back to `lexParseAndRender`
is decision D03: "full rebuild for non-tail region edits." That decision
deferred the block index shift and cache remapping needed when P != Q in a
non-tail region.

To fix 2a, make `incrementalTailUpdate` work for *any* region:

1. When P != Q for a non-tail region, shift all subsequent block indices
   by `+(Q-P)`. This means:
   - Add `shiftFrom(startIndex, delta)` to `BlockHeightIndex` (uses
     `Float64Array.copyWithin`, invalidates prefix sum from shift point)
   - Remap keys in `htmlCache` and `blockNodes` for indices >= S+P
   - Update `regionBlockRanges` start values for all subsequent regions
2. The existing fence propagation (D02 lazy propagation, already implemented)
   handles the "maybe re-lex the next region" case.
3. The DOM is never nuked. Blocks that didn't change keep their DOM nodes,
   their measured heights, and their positions. Spacer heights adjust
   smoothly. The user's scroll position is never touched.

The only remaining path through `lexParseAndRender` should be the cold-start
case: first-ever region when the engine has no prior state. Every subsequent
`setRegion` — tail, middle, or new region at any position — goes through the
incremental path.

The invalidation boundary is always known: the region that was edited, plus
maybe the next one or two if fences are unbalanced. Markdown blocks are a
flat sequence within each region (blockquotes and lists are single blocks in
the lexer output, not containers). Region boundaries are `\n\n` — hard parse
boundaries. This is substantially simpler than HTML invalidation.

**Index shift must update DOM `data-block-index` attributes.** When block
indices shift by `+(Q-P)` after a non-tail splice, the DOM nodes for
subsequent blocks already exist in the container. Their `data-block-index`
attributes must be updated to reflect the new indices, because `addBlockNode`
uses `data-block-index` for insertion sort (ascending document order). Stale
attributes would cause new blocks to be inserted in the wrong position.

**Content shrink: scroll to nearest surviving block.** When a region edit
removes blocks, the total content height shrinks. If the user's viewport
was positioned over blocks that no longer exist, the scroll position must
be adjusted to the nearest surviving block *above* the old position, not
clamped to 0 or the new bottom. This preserves the user's place as closely
as possible per L23. The algorithm: after the splice, if `scrollTop` now
exceeds the new total height minus `clientHeight`, find the block whose
offset is closest to (but not exceeding) the old `scrollTop` and set
`scrollTop` to that block's offset.

**Proposed new Law:** Internal implementation operations must never
lose, destroy, or cease to apply user-visible state. This is the
spirit of L06 ("appearance changes go through CSS and DOM, never
React state") extended to its logical conclusion: the DOM state the
user sees — scroll position, selection, focus, visible content — must
be managed as carefully as any other piece of user data. Nuking and
rebuilding is not management; it is destruction with attempted recovery.

### Problem 2b: scrollToBottom computes the target instead of just slamming it

`SmartScroll.scrollToBottom()` does:

    const target = this._container.scrollHeight - this._container.clientHeight;
    this.scrollTo({ top: target, animated });

This *computes* what it thinks the bottom is. But `scrollHeight` may not
reflect the latest DOM mutations if layout hasn't been forced. And the
computation itself is unnecessary — browsers clamp `scrollTop` to the
maximum scrollable distance automatically. Setting:

    container.scrollTop = Number.MAX_SAFE_INTEGER;

...always puts you at the bottom. No estimation, no stale `scrollHeight`,
no race between content mutation and scroll position. The browser handles
it atomically. This is how terminals work — they don't calculate where the
bottom is; they just say "go to the end."

Every place in the codebase that sets `scrollTop` to "the bottom" using
`scrollHeight - clientHeight` should be replaced with this pattern.

### Diagnosis (streaming follow-bottom jank)

When content arrives during follow-bottom, the update splits across multiple
frames:

**Frame 1 — content arrives (`doSetRegion`):**
- New blocks are added to DOM with *estimated* heights
- Spacers are set from estimated heights
- `scrollToBottom()` fires, setting `scrollTop = scrollHeight - clientHeight`
- This targets the estimated total height — close but not exact

**Frame 2 — ResizeObserver fires:**
- Actual block heights differ from estimates (they almost always do)
- `applySpacers()` updates spacer heights
- But `scrollTop` is NOT adjusted — it still reflects the old estimated height
- The bottom buffer shifts but the viewport stays put → visible gap or jump

**Frame 3 (sometimes) — scroll handler RAF:**
- The `onScroll` callback is deferred to `requestAnimationFrame`
- `blockWindow.update()` runs and adjusts the window
- Another frame of latency between content change and visual settle

The result: streaming content that's following the bottom visibly bounces
between "almost at bottom" and "actually at bottom" on every chunk. A native
terminal never has this problem because it updates content size and scroll
position in a single, synchronous, atomic operation.

### Proposed fix: synchronous measure-before-paint ("double buffer swap")

The core insight comes from graphics programming: double-buffering prevents
visual tearing by composing the next frame in a back buffer, then swapping
atomically so the viewer never sees a partial update. The current code has no
analog — it writes to the live DOM (the "front buffer"), then corrects via
ResizeObserver one or more frames later. The user sees every intermediate state.

**Prior art survey:** No existing web virtual-scroll library solves this for
streaming bottom-following content. react-virtualized's `CellMeasurer` does
off-screen pre-measurement but for lazy loading, not streaming. react-virtuoso,
TanStack Virtual, and react-window all use the estimate-then-correct cycle.
Chat apps (Slack, Discord) live with the jank or mask it with speed. Terminal
emulators (xterm.js, Warp) sidestep the DOM entirely via canvas/GPU rendering.

**The web-native double buffer:** `element.offsetHeight` after DOM insertion.

When a new block node is appended to the DOM, the browser hasn't painted yet.
Reading `offsetHeight` forces a synchronous layout — the browser computes the
actual height *right now*, before returning to JS. This is normally called
"layout thrashing" and considered an anti-pattern. But used strategically —
batch all DOM writes first, then read heights once — it becomes the buffer
swap: you get real measurements before the first paint, eliminating the
estimate→paint→measure→correct→repaint cycle entirely.

This works for our case because streaming content only appends at the tail.
The forced layout touches only new nodes. The prefix is stable.

**Strategy:**

1. **Measure new blocks synchronously before setting scrollTop.** In the
   content update path (`doSetRegion` / `incrementalUpdate`), after adding new
   block nodes to the DOM:
   - Read `offsetHeight` on each newly-added block node (forces synchronous
     layout on the dirty subtree)
   - Write the measured height into `BlockHeightIndex` (replaces the estimate)
   - Recompute spacer heights with real values
   - Set `scrollTop` to the real bottom
   - All in one synchronous call stack → one paint → zero correction needed

   ```
   // After addBlockNode(engine, i) for each new block:
   for (const newIndex of newBlockIndices) {
     const el = engine.blockNodes.get(newIndex);
     if (el) {
       const realHeight = el.offsetHeight;        // ← forced layout ("swap")
       engine.heightIndex.setHeight(newIndex, realHeight);
     }
   }
   // Now spacers and scrollTop use real heights:
   const update = engine.blockWindow.update(scrollTop);
   applySpacers(update.topSpacerHeight, update.bottomSpacerHeight);
   if (isFollowingBottom) {
     container.scrollTop = Number.MAX_SAFE_INTEGER;  // browser clamps to max
   }
   ```

2. **ResizeObserver becomes a safety net, not the primary path.** With
   synchronous measurement, ResizeObserver only fires when something changes
   heights *after* initial layout (font load, image load, container width
   change). When it does fire and `isFollowingBottom` is true, it must also
   correct `scrollTop`:

   ```
   // In the ResizeObserver callback, after applySpacers:
   if (smartScrollRef.current?.isFollowingBottom && scrollContainerRef.current) {
     scrollContainerRef.current.scrollTop = Number.MAX_SAFE_INTEGER;  // browser clamps to max
   }
   ```

3. **RAF deferral becomes harmless, not bypassed.**
   The `onScroll` callback in TugMarkdownView unconditionally defers the
   window update (`blockWindow.update` + `applyWindowUpdate`) to RAF. This
   fires for every scroll event regardless of SmartScroll phase.

   With the synchronous measurement from item 1, the DOM is already in
   the correct state *before* the scroll event fires — blocks are added,
   heights are measured, spacers are set, `scrollTop` is at the bottom.
   When the RAF-deferred window update runs next frame, it calls
   `blockWindow.update()`, gets back no enter/exit changes (everything is
   already correct), and does nothing visible.

   The RAF callback is wasted work (a few microseconds computing "nothing
   changed") but not harmful. No phase-checking logic in the `onScroll`
   callback, no complication to the state machine. The RAF coalescing path
   remains exactly as-is for user-initiated scroll sequences. [D93, L05]

4. **SmartScroll `pinToBottom()` — content growth, not programmatic scroll.**
   Currently `scrollToBottom()` calls `scrollTo()` which enters the
   `programmatic` phase and fires `scrollend`. During rapid streaming, this
   creates overlapping programmatic scroll sequences. This is wrong: content
   growth is not a user-initiated programmatic scroll. It's a side-effect of
   content arriving.

   Add `SmartScroll.pinToBottom()` that sets `scrollTop` to
   `Number.MAX_SAFE_INTEGER` while *staying in `idle` phase*. No
   `_enterProgrammatic()`. No phase transition. The scroll event arrives
   in `idle`, which the state machine already handles: the `idle` case in
   `_handleScroll` checks for re-engagement (scrolling down into near-bottom)
   and does nothing else. This is the correct model — the scroll container
   moved because content grew, not because the user or program asked it to.

   `doSetRegion` calls `pinToBottom()` instead of `scrollToBottom()` when
   `isFollowingBottom` is true. The state machine stays coherent. No flags,
   no hacks, no new phases. [D93]

### Why this works and why nobody else does it

The standard advice is "never read layout properties after writing to the DOM"
because it forces synchronous layout (reflow), which is expensive. Virtual
scroll libraries avoid it by deferring measurement to ResizeObserver (async,
batched by the browser, fires after paint).

But that advice assumes the reflow is *wasted work* — that you're forcing a
layout the browser would have done anyway, just earlier. In our case it's not
wasted: we *need* the height before we can set scrollTop correctly. The choice
is between one synchronous layout now (the "swap") or one layout now *plus*
a ResizeObserver correction layout later (two paints, visible tearing).

The forced layout is also cheap in our case:
- Only new tail blocks are dirty (the prefix hasn't changed)
- Blocks should use `contain: content` in CSS to limit reflow scope
  (not yet present — add to `.tugx-md-block` as part of this work)
- Streaming chunks add 1-3 blocks at a time, not hundreds

For the general case (items appearing anywhere in the list, variable content,
non-streaming), this approach is fragile — you'd force layout on the entire
dirty subtree. But streaming-append-at-tail is the dominant path for
TugMarkdownView, and it's the path where jank is most visible (the user is
watching the bottom).

### What "atomic" means here

The goal is that within a single synchronous call stack:

1. New blocks are added to the DOM
2. `offsetHeight` is read → forced layout (the "buffer swap")
3. Spacer heights are set from real measurements
4. `scrollTop = Number.MAX_SAFE_INTEGER` — browser clamps to actual bottom
5. The browser composites all changes in a single paint

No requestAnimationFrame in between. No setTimeout. No ResizeObserver
correction. No "scroll to bottom on the next frame." One call stack, one
layout, one paint.


## Sequencing

Problem 1 is complete (implemented and merged).

Problem 2 has three sub-problems that should be addressed together:

- **2a (lexParseAndRender destroys user state):** Essential fix. Violates
  L23. Lift the D03 restriction from Problem 1: make `incrementalTailUpdate`
  work for any region, not just the tail. Requires adding `shiftFrom()` to
  BlockHeightIndex and cache/node key remapping when P != Q in non-tail
  regions. These were identified in Problem 1 and deferred by D03.

- **2b (slam scrollTop):** Simple fix. Replace `scrollHeight - clientHeight`
  computations with `Number.MAX_SAFE_INTEGER`. Touches SmartScroll and
  doSetRegion.

- **2c (streaming follow-bottom jank):** The double-buffer strategy plus
  `pinToBottom()`. Touches incrementalTailUpdate, SmartScroll, and the
  ResizeObserver callback. Depends on 2b (pinToBottom uses the slam pattern).

- **CSS contain:** Add `contain: content` to `.tugx-md-block` to limit
  reflow scope for the forced-layout measurement.

Recommendation: fix 2b first (smallest, immediate improvement), then 2c
(streaming path), then 2a (hardest, most touch points).


## Files affected

| File | Problem 1 | Problem 2 |
|------|-----------|-----------|
| `tugdeck/src/components/tugways/tug-markdown-view.tsx` | `incrementalUpdate`, engine state | `doSetRegion`, ResizeObserver callback, scroll handler |
| `tugdeck/src/lib/smart-scroll.ts` | — | New `pinToBottom()` method |
| `tugdeck/src/lib/block-height-index.ts` | — | `shiftFrom()` method for 2a index shift |
| `tugdeck/src/lib/rendered-block-window.ts` | — | — (no changes needed) |
| `tugdeck/src/components/tugways/tug-markdown-view.css` | — | Add `contain: content` to `.tugx-md-block` |
| `tugdeck/src/components/tugways/cards/gallery-markdown-view.tsx` | — | — (gallery card is correct; the bug is in lexParseAndRender) |


## Laws compliance

Both fixes operate entirely in the DOM/CSS appearance zone. No React state is
involved in scroll position management, spacer sizing, or block node
add/remove. Specific law interactions:

- **[L05]** RAF is used for scroll coalescing (DOM reads/writes during user
  scrolls), never for React state commits. Problem 2 adds a synchronous bypass
  for the follow-bottom content-growth path only; the RAF coalescing path is
  unchanged for user-initiated scroll phases.

- **[L06]** All mutations are direct DOM writes: `scrollTop` assignment, spacer
  `style.height`, block node `insertBefore`/`remove`, and the new synchronous
  `offsetHeight` reads. No `setState` anywhere in the scroll or content update
  paths. The forced-layout read is a DOM operation, not a React operation.

- **[L07]** `pinToBottom()` and the ResizeObserver scrollTop correction read
  `smartScrollRef.current` and `scrollContainerRef.current` at call time, never
  via closures that could go stale.

- **[L22]** The streaming PropertyStore observer in `useLayoutEffect` is
  unchanged. The fixes make the DOM writes within its callback more atomic —
  they don't alter the observation mechanism.

- **[L23]** Problem 2a is a direct L23 fix. `lexParseAndRender` destroys user
  scroll state; the incremental path preserves it. Content shrink adjusts to
  the nearest surviving block rather than resetting to 0.

- **[L03]** SmartScroll setup and streaming observer remain in `useLayoutEffect`.
  No change to registration order or timing.

- **[D93]** `pinToBottom()` works within the SmartScroll state machine. No flags,
  no timing hacks. Stays in `idle` phase; the scroll event is handled by the
  existing `idle` case in `_handleScroll`.


## Addendum: Post-implementation bugs in Problem 2

Problem 2 was implemented and merged. Two bugs were discovered immediately
in manual testing. Both stem from the same root cause: the roadmap and plan
only considered *updating existing regions* and never addressed *adding new
regions* or the full consequences of *non-tail region length changes*.

### Bug 1: New regions silently fail to render

**Severity:** Critical. The most basic usage of the component is broken.

**Symptom:** In the gallery card, click 10KB + Static. Scroll bar stays at
top. Click 1KB + Static. Scroll bar jumps to top. Stream button produces
no visible output. Console shows:

    incrementalTailUpdate: no regionBlockRanges entry for key "static-1775089373014"; skipping update
    incrementalTailUpdate: no regionBlockRanges entry for key "stream"; skipping update (x22)

**Root cause:** When `setRegion` is called with a key that doesn't exist in
`regionBlockRanges`, this is a *new region* being appended — not a
programming error. `RegionMap.setRegion` appends new keys at the end.
The old code (before Problem 2) had a `lexParseAndRender` fallback for
this case. Step 6 of the plan replaced that fallback with
`console.warn + return` to satisfy a grep checkpoint, turning the
new-region path into a silent no-op.

**Why this was missed:**

1. The roadmap's Problem 2a section says "every subsequent setRegion goes
   through the incremental path" but never defines what happens when a
   region has no prior entry in `regionBlockRanges`.
2. The plan's Step 6 specification assumes `S` and `P` always come from
   an existing `regionBlockRanges` entry. No task addresses the
   undefined-range case.
3. The critic, overviewer, and reviewer all missed that
   `regionBlockRanges.get(key) === undefined` is a legitimate state
   for new regions, not an error condition.
4. The reviewer required removing `lexParseAndRender` fallbacks to satisfy
   a `grep -c` checkpoint, without recognizing those fallbacks handled
   the new-region case.

**Fix:** When `regionBlockRanges.get(key)` returns undefined, treat it as
a new region being appended:

- `S = engine.blockCount` (new blocks go after all existing blocks)
- `P = 0` (no existing blocks for this region)
- `oldTypes = []` (no prior type sequence)

The normal growth path (Q > 0, P = 0) then runs: lex the region text,
produce Q blocks, append via `appendBlock` (tail) or `shiftFrom`
(non-tail). `regionBlockRanges` gets populated with the new entry at the
end of the function as usual.

This is not a hack or a special case. It is the correct semantics: a new
region has zero existing blocks, and its blocks start after all existing
blocks.

### Bug 2: Stale char offsets for subsequent regions after non-tail edit

**Severity:** Medium. Produces correct rendering but causes unnecessary
re-parsing and could produce wrong text if stale offsets are read between
edits.

**Symptom:** After a non-tail region changes length, the next update to a
subsequent region causes every block in that region to appear "changed"
(triggering unnecessary re-parse), even if the content didn't change.

**Root cause:** When Step 6 generalized `incrementalTailUpdate` for
non-tail regions, it correctly shifts:

- Height index entries (via `shiftFrom`)
- `htmlCache` map keys
- `blockNodes` map keys + `data-block-index` DOM attributes
- `regionBlockRanges` start values for subsequent regions

But it does NOT shift the **values** in `blockStarts[]` and
`blockEnds[]` for subsequent blocks. These arrays hold char offsets into
the full concatenated document text (`engine.regionMap.text`). When
region 'a' changes from 500 chars to 600 chars, every subsequent block's
char offset is now wrong by +100.

The roadmap says "blockStarts/blockEnds arrays are handled by
Array.prototype.splice() automatically." This is true for index
insertion/removal (making room for new blocks or removing old ones).
But `splice` doesn't update the *values* at later indices. The plan
inherited this assumption uncritically.

**Consequences:**

1. `engine.regionMap.text.slice(blockStarts[i], blockEnds[i])` for a
   subsequent-region block returns **wrong text** until that region is
   re-lexed.
2. The next update to a subsequent region compares fresh char offsets
   against the stale ones. Every block appears changed, triggering
   unnecessary re-parse of the entire region.
3. The system self-corrects when the subsequent region is re-lexed (the
   new offsets are computed fresh). So this is a performance bug and a
   latent correctness bug, not a visible rendering error — unless code
   reads stale offsets between edits.

**Fix:** After the index splice and `shiftFrom` for a non-tail edit with
P != Q, compute the char length delta and shift all `blockStarts` and
`blockEnds` values for subsequent blocks:

    const oldRegionCharLength = oldRegionRange.end - oldRegionRange.start;
    const newRegionCharLength = regionText.length;
    const charDelta = newRegionCharLength - oldRegionCharLength;
    if (charDelta !== 0) {
      for (let i = S + Q; i < engine.blockStarts.length; i++) {
        engine.blockStarts[i] += charDelta;
        engine.blockEnds[i] += charDelta;
      }
    }

Note: the old region char length must be captured *before* `setRegion`
updates the region text, or computed from the old `regionBlockRanges`
entry's block offsets.

### Laws compliance for the fixes

Both fixes operate in the same DOM/CSS appearance zone as the rest of
Problem 2. Specific law interactions:

- **[L23]** Bug 1 is a direct L23 violation: the user's action (adding
  content) produces no visible result. The fix ensures new regions render
  correctly. Bug 2's stale offsets are a latent L23 risk: if stale
  offsets were used to render content, the user would see wrong text.
  The fix prevents staleness.

- **[L06]** Both fixes are pure engine-state mutations (array values,
  Map entries) and DOM writes. No React state involved.

- **[L07]** The new-region fix reads `engine.blockCount` at call time
  through the engine ref. The char-offset fix iterates `blockStarts`
  and `blockEnds` arrays in the engine ref. Both access current state
  through refs, not closures.

- **[D93]** Neither fix touches SmartScroll or its state machine.

- **[L05]** Neither fix changes the RAF coalescing path.
