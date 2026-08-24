# Scroll preservation across width changes

## The law

**A change in a card's width never changes what the user is looking at.**

The topmost visible content anchor holds its offset from the viewport top across the whole gesture, including every intermediate frame of an animated resize. A scroller following the bottom stays at the bottom. A scroller whose content cannot reflow (image, PDF) holds its fractional position in content coordinates.

This holds for **every card type** and **every mechanism that changes width**: bullseye, the width popup, ⌃⌘1/2/3, the deck-wide width picker in Lens ▸ Layouts, edge drag-resize, sidebar rail drag, imposition switches, page zoom, font scale.

The rule is the top edge, unconditionally — a visible caret does not claim the anchor. One rule, every card, no per-scroller caret plumbing.

## Why it is broken today

There is no *resize episode*. Every scroll-preservation mechanism in tugdeck is keyed to card mount/unmount, and a width change is neither.

Bullseye is the loudest instance. Toggling it changes exactly one thing in the React tree — the inline `style` on the `.tug-pane` frame. Panes are keyed by stable stack id (`deck-canvas.tsx:2285`) and card content is portaled into a permanent `.tug-pane-content` div (`card-host.tsx:566`), so the scroller element and its `scrollTop` survive intact. That is the problem: `scrollTop` is preserved and the content is not.

Four things move underneath it:

- Bullseye clamps the pane to comfy/800px (`tug-pane.tsx:3363`, `:3445`). Text re-wraps, content height changes, the same numeric offset shows a different line.
- The width is animated, not switched. The FLIP settle tweens real inline `width` over `IMPOSITION_SETTLE_MS` (`deck-canvas.tsx:1976-2028`). Comfy↔wide is far past `MAX_FLIP_SCALE_DISTORTION`, so it is a genuine reflow every frame with nothing anchoring.
- `TugListView` then wipes its measured-height ledger on width settle (`tug-list-view.tsx:2846-2900`) — correctly, since remembered heights are exact only at the width they were measured at. That forces a full re-render and re-measure, and the position drifts again while heights come back.
- Bullseye also changes height (full vertical run), so the viewport grows too.

The only invariant currently defended is follow-bottom (`tug-list-view.tsx:3260-3280`).

CSS scroll anchoring would cover most of this for free. WebKit does not implement `overflow-anchor`, so it has to be ours.

## What already exists

The hard half is built and shipped. Every scroller with real semantics already writes a live anchor into the DOM on every scroll:

- `TugListView` serializes `{anchor: {index, offset, turnDepthFromEnd}, scrollHeight, atBottom}` to `data-tug-scroll-state` every commit (`tug-list-view.tsx:4060-4095`).
- CM6 file blocks serialize `{line: {number, offsetPx}}` on every scroll (`file-block.tsx:779-790`), deliberately line-anchored so font-load reflow cannot move the restore target.
- `SmartScroll.setRestoreTarget(resolver)` / `applyRestoreTarget()` (`smart-scroll.ts:866-935`) is a resolver-based restore that tracks its target as virtualized heights settle, with supersede rules for user gestures already worked out.
- `makeAnchorResolver` (`tug-list-view.tsx:3030-3070`) turns a saved anchor into a live `scrollTop`.
- `CardHost`'s region protocol (`card-host.tsx:475-556`) already discovers every preservable scroller by `[data-tug-scroll-key]` and hands it a cancelable event so smart scrollers can claim their own restore.

A width change is architecturally the same event as a cold boot: throw away measured geometry, re-measure, put the user back where they were. The cold-boot path is what we need; it is simply not wired to resize.

## Design

### The resize episode

New `lib/resize-episode.ts` exposing `beginResizeEpisode(frameEl)` / `endResizeEpisode(frameEl)`.

It discovers scrollers the way `CardHost` already does — `frameEl.querySelectorAll('[data-tug-scroll-key]')`, which reaches portaled card content because `.tug-pane-content` lives inside the frame — and dispatches cancelable `tug-scroll-preserve-begin` / `tug-scroll-preserve-end` on each, mirroring the `tug-region-scroll-set` protocol. A scroller with real anchor semantics handles the event and calls `preventDefault`; one without falls through to a generic anchor implemented in the module. No registry, no new plumbing: the same seam, extended to a second occasion.

Raise sites, all of which already know when width moves:

| Gesture | Site |
|---|---|
| Bullseye, imposition, deck-wide width, preset change | `deck-canvas.tsx:1976` — the settle already computes `widthChanges`; begin before the Last pass, end from the `Promise.allSettled` that runs `restores` (`:2032`) |
| Drag-resize (8 edges) | `tug-pane.tsx:2937` `handleResizeStart` → pointerup |
| Sidebar / rail edge drag | `tug-pane.tsx:3175` `handleSidebarResizeStart` |
| Page zoom, font scale | reaches scrollers as a `clientWidth` change; the ResizeObserver path below covers it without an explicit episode |

The end signal must fire even when the animation never runs — a background app-test window suspends rAF entirely. End is raised from the settle's completion path plus a wall-clock safety net, never from an animation callback alone.

### Scroller handlers

| Scroller | Anchor | Work |
|---|---|---|
| `TugListView` (transcript, Jots, Lens, sheets, keyboard, path/search/todo blocks) | the `{index, offset, turnDepth}` it already writes | on begin, feed the live anchor to `setRestoreTarget(makeAnchorResolver(...))`; the existing `applyRestoreTarget` heartbeat lands it as the re-measure completes. `atBottom` skips the anchor entirely and lets `maybePinToBottom` own it |
| CM6 (text card, file blocks, prompt entry, gazette composer, jots) | line number + intra-line px | hoist `file-block.tsx:779`'s `writeScrollState` into the shared `tug-text-editor` substrate so every CM6 scroller carries it; restore exactly via `view.lineBlockAt(line.from).top + offsetPx` |
| `TugMarkdownView` | block index + offset | it already has block offsets and a shrink-recovery snap (`tug-markdown-view.tsx:854-869`); reuse both |
| PDF | page index + fraction | own listener; pages are absolutely positioned from a document model, so a pixel anchor is wrong |
| Plain flow (diff, gazette transcript, settings, devtools, image, the `.tug-pane-content` host itself) | generic | module fallback: at begin, `elementFromPoint` at the scroller's top inset, walk to the nearest stable child, record `rect.top − scrollerRect.top`; on each subsequent measurement, `scrollTop += (newRect.top − scrollerRect.top) − saved` |

### Continuity during the tween

Content reflows live and is re-anchored on every `ResizeObserver` fire while an episode is open — one `scrollTop` write per delivery. The content stays visually still while the frame animates; there is no snap at the end. The hooks are the existing container observers (`tug-list-view.tsx:3260`, `tug-markdown-view.tsx:493`), which today only bottom-pin and re-window.

### The subtle part

`applyRestoreTarget`'s drift-supersede (`smart-scroll.ts:920-930`) assumes content growth never moves `scrollTop`. True for growth below the viewport; false for a re-wrap above it, which is exactly what a width change produces. Left alone the restore cancels itself mid-episode and the fix silently does nothing.

An episode-scoped restore target suspends the drift check for the episode's duration. The `isUserScrolling` supersede stays live, so grabbing the scrollbar mid-resize still hands the position back to the user.

### Guard

`TugListView` publishes `data-scroll-displacements` (`tug-list-view.tsx:3298`), a displacement counter with a documented zero floor. Generalize it to every preserving scroller and assert it stays flat across width gestures.

Then a parameterized app-test over card type × width gesture: scroll to a known mid-content element, change width, assert that element's viewport-relative top is unchanged. Extend `at0372-bullseye.test.ts` and add a new file with `@covers` on the episode module and each handler.

## Sequencing

1. The episode primitive plus the `TugListView` handler. This fixes the transcript, Jots, Lens, and every sheet in one move — the majority of the visible damage — and is mostly wiring existing parts together.
2. CM6, by hoisting the one existing writer into the shared substrate.
3. The generic fallback for plain-flow cards.
4. PDF and image.

The law text lands in `tuglaws/state-preservation.md` alongside [L23], whose current prose covers cross-mount preservation and is silent on resize.
