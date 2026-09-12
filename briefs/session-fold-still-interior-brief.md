# The fold's motion, second attempt: hold the interior still and sweep one edge

**Purpose:** The fold landed by `session-fold-chord-and-motion-brief.md` moves everything inside the Session card except the masthead, and moves Z2 backwards at the end of every unfold. The card should resize as a tight clip over a still interior: one edge moves, Z2 rides it in one direction, and nothing else inside the card changes but the fold control's glyph. This supersedes the motion half of that brief ([B04]–[B07] there); its chord half stands.

---

## Purpose {#purpose}

In the user's words, after `tugarc/session-chord-motion` landed as `9cb11f730`:

> the fold/unfold animation is *riotously bad*. I mean, it's ***way*** worse than it was before this change. It's a loopy, slow-performing, mess of content and component moving around. I want a *tight* card resize, where the content on display in the card *does not shift around* while the card is being resized.

And on Z2, after the first sketch:

> Z2 needs to stay put for sure, it now does a re-layout during the fold/unfold. It should not. The only thing that should change during fold/unfold is the icon in the fold/unfold button. What's more, the Z2 area should make a smooth vertical motion *up* when folding and *down* when unfolding, without any retrograde motion.

So the target is three sentences. The interior never re-flows. Z2 is a rigid strip that travels up on the fold and down on the unfold, monotonically. Inside Z2 the glyph is the only thing that changes.

---

## Evidence {#evidence}

Measured with a throwaway per-frame census in the real app (`requestAnimationFrame` sampler over `set-card-folded` in both directions, one bound Session card in a one-up whose frame the imposition sized to 1041px, folded tier 158px). The test file was deleted after the run; the numbers below are its output.

**[F01] The "still picture" is welded to the edge that moves.** The arc froze the transcript's *height* and anchored the frozen box with `justify-content: flex-end` on `.session-view-slot`, so its bottom sits on the slot's bottom, which is Z2's top, which rides the closing edge. On the fold in, the transcript pane's top went from 109px to −560px in 200ms: the whole transcript translates at the edge's speed. The composer does the same from the other side, since `align-self: start` pins it to the entry region's top, which is Z2's bottom; its top went from 831px to 153px. Only the masthead holds still. AT0563 passes because it asserts the pane's height spread, not its position. **(verified)**

**[F02] Two clocks wearing one duration.** The frame rides the imposer's critically damped spring (`lib/imposer-motion.ts`, ζ = 1, ω = 6, sampled over its own settle and replayed over the 400ms window), which is 94% done at the halfway mark. The entry region's `grid-template-rows` rides a CSS transition with `ease-out`, 69% done at the same instant. They share a duration and nothing else. AT0555's claim 1 asserts the duration equality and calls it "one clock"; it is one window on two curves. **(verified by reading and by simulation; confirmed by [F03], [F04])**

**[F03] The fold in finishes twice.** The frame reached 220px of its 883px travel by 220ms and then crept to 158px over the next 200ms while the composer row went on collapsing from 70px to 0. Z2 sat clamped at the masthead's bottom from 226ms on; the card's bottom edge drifted 9px over the remaining half of the window. The visible motion is over in a fifth of a second and the card then takes another fifth to stop. **(verified)**

**[F04] The unfold has retrograde motion.** Z2's top rose to 795px at 261ms and then fell back to 778px by 410ms. The transcript pane's top overshot to 126px and returned to 109px over the same 150ms; the entry region's top did the same. This is [F02]'s difference curve: the frame is done while the composer's row is still growing, and the growth pushes Z2 and the picture back up. **(verified)**

**[F05] Nothing in Z2 is keyed on the fold, and the interior is re-laid-out every frame anyway.** No rule in `session-card.css`, `tug-status-cell.css` or the telemetry renderers selects on `data-folded` or `data-fold`; the `@container session-status` rungs are `inline-size` only and the width does not change. What the reader sees as Z2 re-laying-out is the per-frame layout of everything under `.session-card`, which is `height: 100%` of a tweening box with `container-type: size`, a flex chain, a transitioning grid row, and the arc's own slot `ResizeObserver` delivering and refusing on every frame, plus [F04]'s reversal. Frame pacing on an empty transcript was a steady 16 to 17ms; a loaded transcript was not measured. **(verified for the stylesheets and the pacing; the loaded-transcript cost is inferred from the structure)**

**[F06] The imposer already holds the open geometry in both directions.** Its FLIP pass measures every frame's rect before the commit (First) and after it (Last), in `deck-canvas.tsx`'s arm and settle. On a fold in, First is the open box. On an unfold, Last is the open box, provided nothing inside the card is mid-transition at that instant, which [B03] arranges. The card's own layout effect sees neither: the arc found that a forced layout there reports the folded geometry, which is why it built a cache and a watcher. **(verified by reading)**

**[F07] A sticky descendant is already legal above the card.** `.tug-pane-chrome` and `.tug-pane-body` are `overflow: clip` precisely so they do not form a scroll container that would trap `position: sticky` (`tug-pane.css`, the comment on `.tug-pane-chrome`). `.tug-pane-content` is `overflow: auto`, a scroll container, and the card portal's slot is `display: contents`, so `.session-card` is its direct layout child. Z2's containing block is `.session-card-top-column`, `position: relative`, of which Z2 is the last child. Nothing currently overflows the content box, so a sticky Z2 would be inert in the open form. **(verified)**

**[F08] The folded tier is masthead plus Z2 and nothing between.** At `data-fold="settled"` the slot is `display: none`, the column is `flex: 0 0 auto`, the entry region is `0fr`; the census shows Z2's top at 109px under a 158px frame with the slot at zero height. So the last frame of a clip that leaves only the masthead and a Z2 stuck to the bottom edge is pixel-identical to the settled form, and the cut to it is invisible. **(verified)**

---

## Decisions {#decisions}

**[B01] The interior is laid out once, at the open size, and clipped by the frame.** For the length of the crossing the card root carries a definite pixel height equal to its open content height, the pane's content box clips it, and the slot, the column and the entry region keep their open layout throughout. The list view's scroller has a box that never changes, so its container observer delivers nothing; CodeMirror's host never resizes; the size container's height is constant. A subtree with a definite height that does not change is not dirtied by its ancestor's tween, which is where the per-frame cost of [F05] goes. This retires `--session-fold-slot-height`, `data-fold-freeze`, the slot `ResizeObserver` and its re-measure on land, and both anchors from the previous brief.

**[B02] Z2 is one rigid strip that rides the edge by `position: sticky; bottom: 0`.** Inert in the open form, since the card fills the content box exactly ([F07]). During the crossing the content box shrinks past Z2's natural place and the browser holds Z2 at the visible bottom edge: it travels up on the fold and down on the unfold, at the frame's own speed, and it cannot reverse because the frame's spring cannot ([F02]'s second curve is gone, [B03]). Sticky is an offset resolved at layout, not a re-layout of the strip: the cells, the gaps and the control keep the boxes they had, and the glyph is the only thing in Z2 that changes. It is sticky rather than a transform on the imposer's keyframes because the browser is already computing the edge; a transform would be a second copy of the same number kept in step by hand.

**[B03] The entry region's `grid-template-rows` transition is deleted.** The row is `1fr` inside the picture and `0fr` at `settled`, a cut under Z2 where nothing is visible ([F08]). With it goes the only tween in the card that was not the frame's, so [F02] cannot recur by construction and [F06]'s Last rect on the unfold is the true open layout. The `transitionend` landing and its backstop timer go with it; the crossing's end is the imposer's ([B05]).

**[B04] The imposer owns the held height, and it comes from the rects it already takes.** A frame whose `data-folded` differs between First and Last, and whose height term tweens, is a fold crossing. The imposer marks the frame for the tween's life and writes the larger of the two content heights onto the content box's child as the held height: First on the fold in, Last on the unfold ([F06]). No cache, no watcher, no stale value on a pane resized while folded, and no measurement inside the card at all. The mark is what the card's CSS keys the held layout on, and what turns `.tug-pane-content` from `overflow: auto` to `overflow: hidden` for the crossing, so the overflowing interior draws no scrollbar and takes no wheel.

**[B05] The card's fold effect keeps only what CSS cannot write, on the imposer's clock.** `inert` on the two regions and `data-fold="settled"` are written when the crossing ends, signalled by an event dispatched on the frame from the settle's completion, in the shape the resize-episode events already use (`lib/resize-episode.ts`). A card with no crossing to wait on, because motion is off or reduced, lands at once, exactly as it does today. Every appearance change stays in CSS and the DOM ([L06], [L13]).

**[B06] The reading is an edge sweep over a still card.** Fold in: the edge rises through the composer, then Z2 lifts off its place and rides up over the transcript, covering the newest lines first, until it meets the masthead. Unfold: Z2 stuck to the edge slides down, uncovering the transcript from the top, comes to rest at its open place, and the edge goes on down through the composer. Nothing inside translates at any frame. This supersedes [B07] of the previous brief, which wanted the live edge visible longest: keeping it visible means moving the transcript, which is the defect. It also refines [D185]'s candidate (c): at this tempo the composer is under the edge in the first fifty milliseconds and the rest is Z2's travel, which is one motion.

**[B07] The tests are rewritten to the new claim, not re-pointed.** AT0563 asserts *position*: across every moving frame, the transcript pane's top and the composer's top do not change, Z2's top is monotonic in the direction of the fold, and the frame's height travels its full extent. AT0555's claim 1, the declared-duration equality, is retired with the transition it measured; its claims 2 and 3, the wall neighbour's travel and the composer coming back whole, stand. The previous brief's stillness test measured the wrong quantity and is not carried forward as-is.

---

## Open Questions {#open-questions}

- **Whether every height crossing should hold its interior, not only the fold.** The imposer's own comment says height gestures halve or double a frame and never smear, so a wall opening or a rail mode flip re-lays-out its members every frame today for the same reason the fold did. [B04]'s mark could be "any height crossing" rather than "a fold crossing" at no extra cost, and every Session card in a wall would fold and unfold the same way. It is left open because the other crossings have not been looked at, and a member growing into a rail's run may want its transcript to reflow rather than be revealed. Settle it by watching a wall open with the mark on both ways.

---

## Non-goals {#non-goals}

- **Z2 staying at its open position while the edge clips.** Z2 would go under the clip mid-fold and reappear at the end. The user's ask is a strip that travels, and [B02] is that.
- **A bottom-anchored transcript, the live edge visible longest.** [B07] of the previous brief, rejected by [F01]: any anchor on the moving edge translates the picture.
- **Translating Z2 with a transform on the imposer's keyframes.** Same picture as [B02], with the edge's position kept in two places. Sticky is the browser's copy.
- **Retiming or re-easing the entry region's transition to match the spring.** A sampled `linear()` easing on the row would reproduce the frame's curve but keep two effects that can drift; the row does not need to move at all ([B03]).
- **Keeping the arc's cached open height and holding the card root with it, a card-only fix.** Smaller diff, and it works for the fold in, but the unfold keeps the stale-cache jump on a pane resized while folded, which [B04] removes for free. Not chosen; recorded so it is not proposed as the quick version.
- **Fading the transcript during the fold.** Rejected in the previous brief for hiding churn rather than stopping it; with [B01] there is no churn to hide.
- **The chord half of the previous brief.** ⌃⌘Y, the glyph reading and the `chord-tiers.md` paragraph are landed and untouched.

---

## Exit {#exit}

An arc. The order that matters is that the imposer's mark and held height ([B04]) land before the card's CSS depends on them, and that the transition comes out ([B03]) in the same step the sticky Z2 goes in ([B02]), since either alone reintroduces a second motion.

First steps, in shape: the fold-crossing detection and the held height in `deck-canvas.tsx`'s settle, with the frame mark and the end event; `tug-pane.css` keying the content box's overflow on the mark; `session-card.css` losing the freeze block, the anchors and the row transition, gaining the held card height and the sticky Z2; `session-card.tsx` losing the slot watcher, the cache and the `transitionend` landing, keeping `inert` and the terminal state on the end event; then AT0563 and AT0555 rewritten to [B07]. Verification is the census that produced [F01]–[F04], run again: fold and unfold a card with a long transcript, at the live edge and parked in history, and in a wall, and read that no top inside the card moves, that Z2's top is monotonic, and that the frame's edge is the only thing that does.
