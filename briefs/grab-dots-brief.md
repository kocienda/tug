# Grab Dots — a drag affordance for content cards

**Purpose:** A content card's title bar is the drag surface along its whole run and nothing says so at rest; you find the handle by trying it. This brief settles a mark that says it — and settles it against the racing stripe, which a rail already wears.

---

## Purpose {#purpose}

The ask, in the user's words: *"I want to make it more clear where you can drag a content card (session, text, diff, etc.)."* The first proposal was *"some kind of racing stripe to content cards, but I want to do it in such a way as to differentiate content cards from sidebar cards."*

That framing ran into the fact recorded as [F01] and was replaced, in the user's own words, with the mark this brief carries: *"two rows of grab dots that live in between the session title and the `…` menu … subtle, rather than bright, and clearly distinguished from the `…` menu."* Three rounds of review on the `grab-dots` spike settled the geometry and the trigger.

The problem is not decorative. Every content card on the deck is dragged by its chrome — between panes, into a stack, onto a tab bar to merge — and the gesture has no visible seat. A person who does not already know the bar is draggable has no way to learn it from looking.

---

## Evidence {#evidence}

**[F01] The racing stripe is already the rail's livery, and it is load-bearing.** A rail (`layoutRole: "sidebar"`, 32px flush bar) wears three 1px hairlines on a 3px pitch in two flex-grown bands flanking a centered glyph and a tracked label — `tugdeck/src/components/tugways/tug-pane.css:655`. The comment there records that this is most of how a tool's bar reads as different from a document's. So a content-card stripe cannot be the rail's stripe at another station; it has to be a different mark. **(verified — read out of the stylesheet)**

**[F02] The gap between a masthead's title and its `…` is not a slot.** The lead line is a flex row of `[glyph][title]`, and the title is `flex: 1 1 auto` with an ellipsis box (`tugdeck/src/components/tugways/tug-session-row.css:186`). The line then reserves the control cluster with `padding-inline-end: calc(var(--tugx-pane-controls-width) + var(--tug-space-xs))`. The empty run a reader sees is therefore slack **inside the title's own box**, held by the title — so putting anything there means taking the grow away from the title and handing it to the new item. **(verified — read out of the stylesheet)**

**[F03] Three masthead tiers share that name line, and the card in the screengrab is the one the spike did not model.** `session-masthead.css:63`, `card-masthead.css:74` and `commit-masthead.css:27` each reserve the cluster on `.tug-session-row-name-line`, and `CardMastheadPayload` is a union of `SessionMastheadPayload`, `DocumentMastheadPayload` and `CommitMastheadPayload` (`tugdeck/src/lib/card-title-store.ts:154`). The screengrab shows a **session** masthead (`tug/waxen-vixen`, phase dot); the spike stands in a `DocumentMastheadPayload`, because the session tier needs an identity store behind it. The session tier's reserve additionally subtracts `--tugx-session-row-trailing-inset`, which the other two do not. **(verified — read out of the three stylesheets)**

**[F04] Five cards are rails; everything else is content.** `layoutRole: "sidebar"` appears in exactly five registrations — Cards, Layout, Jots, Arcs, Overview. Every other registered card is content by default. So "content cards only" is a `:not([data-role="sidebar"])` on the bar, not an allow-list to maintain. **(verified — grep over `src/`, excluding tests)**

**[F05] A tiled dot-grid background renders its dots at visibly different sizes.** The spike's first pass drew `background-image: radial-gradient(…)` + `background-size: 4px 4px` + `repeat`, and the user reported the dots looking unequal — twice, the second time in capitals. Two mechanisms compound: a repeated background is composited tile by tile with each tile's device rect rounded independently, and the field never begins on a device pixel, being a flex item after a run of text; and a 1px circle is a curve sampled at one pixel, so its rasterization is entirely antialiasing. Neighbouring dots round opposite ways — one lands clean, the next spreads over two columns at half coverage and reads as larger, softer and fainter. **(the unevenness is verified — observed on screen by the user and reproduced in the spike. The mechanism is inference from how engines composite tiled backgrounds; what would confirm it is a device-pixel capture of the two techniques at the same origin.)**

**[F06] The replacement technique renders uniformly.** A solid ink box masked to 1px **squares** by two crossed hard-edged `repeating-linear-gradient`s composited with `mask-composite: intersect` — each gradient painted once across the whole box, so no tiles to round and no curve to antialias, and every dot shares one subpixel phase. The spike carries an 8× inspection strip for reading this. **(verified — the spike renders it; the strip is the check)**

**[F07] The classes the field hangs off are shared with the Cards rail.** `.tug-session-row-name-line` and `.tug-list-row-title` belong to `TugSessionRow`, which the Cards sidebar's session cells also mount. The spike's `.tug-list-row-title { flex: 0 1 auto }` override — the one that takes the grow away per [F02] — is scoped under `.sp-dots` and would change every session row in the Cards rail if it were not. **(verified — read out of `tug-session-row.tsx` and the spike's scoping)**

**[F08] The name line has a third slot that no masthead uses today.** `TugSessionRow` renders an optional `.tug-session-row-slots` child after the title; the only mount passing one is `tugdeck/src/components/cards/cards-session-cell.tsx:141`. No masthead passes `slots`. A field added after the title is therefore unambiguous now, but its order relative to `slots` is undefined and would matter the day a masthead wants one. **(verified — grep over `src/`)**

**[F09] The utility tier's run is a real flex gap, unlike the masthead's.** A 36px `.tug-pane-title-bar` is `justify-content: space-between` over two children — the title group and the controls — so a field added there is an ordinary flex item. Because a `::after` is last in document order, the controls need `order: 1` for the field to land before the close box; this is the same adjustment the rail's own stripe rule already makes. **(verified — read out of `tug-pane.css:475` and `:604`)**

---

## Decisions {#decisions}

**[B01] The mark is a field of 1px dots, three rows deep, on a 4px grid, filling the run between the title and the control cluster.** Settled by review across three rounds on the `grab-dots` spike. The dot is a constant, not a knob: the row count and the pitch may be retuned, the dot may not. Three rows over two because the field's whole claim against the `…` is that it is a **block** of dots where the button is a **line** of them, and the third row buys that distinction at a cost the review accepted.

**[B02] The block-size is derived as `(rows − 1) × pitch + dot`, never stated.** 5px at two rows, 9px at three, on a 4px pitch. Stating a height independently of the pitch would sooner or later cut a partial row and hand the `…` its argument back; deriving it makes the block/line distinction structural rather than remembered.

**[B03] The field is drawn as a masked solid, not as a tiled background.** Two crossed hard-edged `repeating-linear-gradient`s under `mask-composite: intersect`, with `mask-repeat: no-repeat` and `mask-size: 100% 100%` stated rather than defaulted — a repeated mask reintroduces exactly the per-tile rounding this exists to avoid. Follows [F05] and [F06]. The stencil's `#000` stops are not a color and must not be tokenized: `mask-mode` defaults to `alpha`, so the stop means "opaque here", and a stencil that moved with the theme would be a defect.

**[B04] The mark appears on content cards only, and never on a rail.** Implemented as `:not([data-role="sidebar"])` on the title bar per [F04] — not an allow-list. The reason is not visual differentiation: a rail is pinned to a deck edge and is not dragged by its bar, so a drag affordance on one would advertise a gesture that does not exist. This supersedes the original framing of the ask, which was to differentiate two liveries; the answer is that only one surface gets a livery at all.

**[B05] The trigger is hovering the title bar or masthead, not the card.** The mark appears exactly where `cursor: grab` already is, so the thing that lights up is the surface that will take the press — affordance and gesture share one boundary. Card hover was settled first, on the argument that crossing a card teaches you more than reaching its chrome does; it is reversed here. A mark firing from anywhere inside a card claims the whole card is the handle, which is the wrong claim, and on a dense deck every pointer move would light one. Learnability is what this gives up, and the trade is accepted: the bar is already where the cursor changes, so the two signals now arrive together instead of from different places.

**[B06] The field holds its flex space at all times; only `opacity` changes.** A title that reflowed under the pointer would be a worse problem than the one the mark solves. The consequence is accepted rather than unnoticed: a long title elides earlier than it does today **even at rest**, because the space is held whether or not anything is drawn in it. See the open question below.

**[B07] The field is not lifted at all.** The 0.5px optical nudge the spike carried is removed; the field sits where the flex line's `align-self: center` puts it. The nudge existed for a real reason — a line of text centers on its line box, whose lower half is descender space the name mostly leaves empty, so the word's optical center sits above the geometric one — but a sub-pixel correction that is one device pixel at 2× and half of one at 1× buys less than the resolution question it opens, and it retires that question with it. Should anyone revisit it, the constraint stands: a lift would be a `translate` and never a margin or an inset, because the field is a flex item holding the run open and anything that moved it through layout would move what it is holding.

**[B08] The ink comes from the card-titlebar family, mixed toward transparent.** `--tugx-pane-title-bar-icon-active` / `-inactive` at roughly 50% / 45%. A content card keeps its tinted title band, so the ink must be authored against that tint; the rail's stripes use the global family for the opposite reason, having given the tint up. Carrying one family onto the other's ground is the near-white-on-near-white failure the rail's first pass shipped, and it is the specific error this decision exists to prevent.

**[B09] The rollout is scoped to the three masthead name lines and the utility title bar — never to `TugSessionRow` in general.** Per [F03] and [F07]: the grow-removal and the field must key off the masthead row classes (`.session-masthead-row`, `.card-masthead-row`, `.commit-masthead-row`) or off the title bar, so that the Cards rail's session cells, which mount the same component, are untouched.

---

## Open Questions {#open-questions}

- **Does the permanent measure cost to long titles stand?** [B06] holds the field's space at rest, so every content card's title elides earlier than today by the field's floor plus its leading margin — roughly 40px — with nothing visible in that space most of the time. The alternative is absolutely positioning the field so it costs no layout, but an absolute field cannot know where the title's slack ends and would paint over a long name on hover. Settling this needs a look at real cards with real titles, not a rule.

- **Should the field stay up while a drag is in flight?** Sharper under [B05] than it was under card hover: the drag begins from a press inside the bar, so the field is up at the moment of grab, but the gesture then carries the pointer off the bar and a plain `:hover` rule would drop the mark mid-drag — the card is being dragged and its handle has gone dark. Either that is fine, or the pane's existing `data-gesture` pins the field for the duration. Settling it needs the pointer.

- **Does the commit masthead read right with it?** [B04] makes a commit card content, so it gets the mark. Its tier also carries a `CommitMetaCell` whose ink was re-pointed for the chrome band, and nobody has looked at the two together.

- **Is there a no-pointer path at all?** Hover-only means keyboard and touch users get no affordance. That may be acceptable — the drag itself is pointer-only — but if card drag ever gets a keyboard route, the mark needs a story.

---

## Non-goals {#non-goals}

- **A livery for rails.** Rejected per [B04]: a rail is not dragged by its bar. The original ask framed this as differentiating two marks; the finding is that the second surface should have no mark.

- **The five stripe treatments from the first spike round** — crown (the rail's hairlines on the band's top edge), grip (the same rotated, as a leading patch), hatch (a diagonal hatch across the band), keel (a 2px accent rule on the bottom edge), coachline (a hairline hugging each edge). All rejected by review in favour of the dot field. Recorded so they are not re-proposed.

- **The `lead` and `trail` placements** — a fixed dot patch hugging the title's end or the controls. Rejected in favour of filling the whole run, which is the honest statement since the whole bar is the drag surface. `trail` was the only placement that left the title's grow alone, so if the open question about measure cost resolves against [B06], `trail` is where to look first.

- **Varying the dot size.** Ruled out explicitly and twice by the user. Density is the only axis; the dot is a constant.

- **A rest-state mark.** [B05] takes bar hover. A mark visible at rest was considered and is what the first two spike rounds showed; the band being completely clean until you reach for it was preferred.

- **A card-hover trigger, and the 0.5px lift.** Both were settled on the spike and both are reversed here — see [B05] and [B07]. Recorded so they are not re-proposed: the field fires from the chrome alone, and it is not nudged.

- **Retuning the rail's stripes.** Out of scope. This work reads `tug-pane.css:655` and changes nothing in it.

---

## Exit {#exit}

**An arc.** The work is one mark, in CSS, applied at four places, with a fixture already standing.

What the first moves look like:

- The field, its knobs and its stencil move out of `tugdeck/src/spikes/spike-grab-dots.css` into the shipping stylesheets. The utility-tier rule belongs in `tug-pane.css` beside the rail's own stripe rule, which already makes the `order: 1` adjustment [F09] needs; the three masthead rules belong with their tiers, keyed per [B09].
- The grow-removal on `.tug-list-row-title` is the change most able to do damage — [F07] — so whatever lands it should be checked against the Cards rail in the same breath, not after.
- The `data-role="sidebar"` exclusion [B04] is one selector and should go in with the first rule rather than afterwards, so no build ever exists in which a rail wears the mark.
- The spike is the reference while this lands and is deleted when it does. Its `@covers` question is worth asking early: no app-test names this chrome today, and a 1px-dot field is exactly the kind of mark a screenshot test can hold and prose cannot.

The two open questions about measure cost and 1× rendering do not block the first rules; both are visible once the mark is on real cards, which is the cheapest place to settle them.
