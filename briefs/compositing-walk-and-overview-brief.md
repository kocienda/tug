<!-- brief-skeleton v1 -->

# The compositing walk and the Overview's size

**Purpose:** Every frame that carries a style change pays about 6 ms before paint on a full deck, priced by how much is mounted rather than by what moves, and the Overview card is the largest thing mounted. It is a floor under every animation, and no work has addressed either half.

---

## Purpose {#purpose}

`briefs/graphics-animations-asks.md` carried two findings in from the flow-slide work and left them to "the unification work". The 2026-10-01 audit found nothing had taken them up, and the user asked for them to be briefed:

> **The 6 ms compositing walk and the Overview's size** are a floor under every beat, and nothing has addressed either.

A 16.7 ms frame that spends 6 ms in a walk unrelated to the motion has 10 ms for everything else. Every gesture the asks brief lists — the flow slide, the fold, the split, the rails — plans inside what is left.

---

## Evidence {#evidence}

**[F01] A frame with a style change costs about 6 ms before paint on a full deck, and it is the compositing walk.** From the asks brief's findings carried in: writing a 1 px width on a hidden fixed element each frame, at rest, read 6–7 ms to the end of style and layout and 1 ms of paint; at-rest samples put nearly all of it in `updateCompositingLayersAfterStyleChange` and `computeCompositingRequirements`. The deck held 23,116 elements, 1,435 stacking contexts and 7,226 render-layer candidates (`tugtool deck motion layers`). A steady tween frame read 10–12 ms to the end of style and layout. **(verified, measured on the user's release deck)**

**[F02] On a freshly launched deck the walk is still the largest thing the main thread does in a slide.** 10,927 elements, 718 stacking contexts, 3,456 candidates: 19 of 35 rendering samples across four gestures. **(verified, measured)**

**[F03] The walk is priced by population.** `tuglaws/animation-doctrine.md`'s engine facts, source-verified against WebKit: a transform-family style diff trips the `computeCompositingRequirements` traversal over the whole page's layer tree, and `will-change` does not avoid it. Which population term prices it on this deck — elements, stacking contexts, or render-layer candidates — has not been separated by measurement. **(verified for the mechanism; the pricing term is not measured)**

**[F04] The Overview is the largest thing on the deck, is not skipped when unseen, and grows as sessions work.** About 9,600 elements at the start of one investigation and 12,349 half an hour later: 908 approximate stacking contexts, 173 `position: sticky` elements, 48,605 characters of text, and no element with `content-visibility: auto`. After a relaunch it held 3,745. It resets only when the app does. **(verified, measured)**

**[F05] The day's lost frames tracked a process whose deck had doubled.** Flow-slide-remainder `[F02]`: readings that lost frames were taken on a WebContent process whose element count grew from ~11k to ~22k; a relaunch restored the frames. Whether the loss tracks element count, the Overview, or something the census does not show is the aging reading that brief left with the user, and it has not been taken. **(verified that a relaunch restored the frames; the cause is not measured)**

**[F06] A parked workspace's layer stays laid out.** [L23] records that a hidden workspace layer is `visibility: hidden` over `content-visibility: hidden` and keeps its layout. Whether its elements still count toward the walk has not been read. **(verified for the law; the walk's treatment of parked layers is not measured)**

---

## Decisions {#decisions}

**[B01] The walk's pricing term is measured before anything is cut.** `[F03]` leaves three candidates, and they call for different work: fewer elements, fewer stacking contexts, or fewer layer candidates. The reading is an additive bisect on the release deck — the walk's cost with the Overview's content skipped, with a parked workspace present and absent, and with a transcript's off-screen rows skipped — taken with `tugtool deck motion`, extended if it cannot take it. The animation doctrine's rule holds: cheap is a reading on the user's deck, never a bench number.

**[B02] The Overview is the first thing measured against, because it is the largest and it grows.** `[F04]` makes it the one card whose share is both big and unbounded. The first candidate is skipping its unseen rows (`content-visibility: auto` with an intrinsic size) so they leave the walk without leaving the DOM; `[B01]`'s reading says whether that moves the walk at all before it is built.

**[B03] The aging reading is taken as part of this work, not left standing.** `[F05]`'s open question is this brief's subject seen from the other side: what a long-running deck accumulates. It is the user's reading, since it needs hours of ordinary use, and when taken it is read against `[B01]`'s bisect so what accumulated is named.

**[B04] A change lands only with the walk read before and after on the release deck, with census and build sha recorded.** And with the at-rest invariant intact: nothing here may add a rendering update to a still deck ([D1]).

---

## Open Questions {#open-questions}

- **Should the Overview hold fewer rows, or only skip the ones unseen?** This is a product call about the Overview and it is the user's. Skipping keeps everything reachable by scroll and find; holding fewer bounds the card outright but drops history from the card. `[B01]`'s reading informs it: if skipped rows still price the walk, only holding fewer helps.
- **Does `content-visibility: auto` remove a subtree from the compositing walk in this WebKit?** Settled by the bisect. If it does not, the route is fewer stacking contexts or fewer mounted rows.
- **What are the 908 stacking contexts and 173 sticky elements in the Overview for?** Read from its stylesheets; some may be avoidable at no visible cost.
- **Do parked workspaces pay into the walk?** Settled by the bisect (`[F06]`). If they do, the cheap workspace switch has a standing per-frame price that grows with the number of mounted workspaces.
- **Does find-in-page, selection or scroll anchoring break on skipped rows?** To be checked on whatever is skipped before it lands ([L23]).

---

## Non-goals {#non-goals}

- **Taking React out of the gesture's task.** That is `briefs/gesture-task-without-react-brief.md`; the two costs are independent and add.
- **`will-change` or layer hints as the fix.** The doctrine measured them: they buy nothing against the walk and cost population.
- **Unmounting parked workspaces.** The cheap switch rests on them staying mounted; if they price the walk, that is reported and decided separately.
- **Benching instead of reading the deck.**

---

## Exit {#exit}

**An arc.** It begins with the bisect (`[B01]`): extend `tugtool deck motion` so the walk's per-frame cost can be read with a named subtree skipped, and read it for the Overview, a parked workspace and a long transcript. That reading settles the pricing term and whether skipping helps. The Overview product question then goes to the user with the numbers beside it; what gets built follows from the answer. The aging reading (`[B03]`) is the user's and lands when the deck has aged.
