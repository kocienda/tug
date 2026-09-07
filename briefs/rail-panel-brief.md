# Rail Panel: a sidebar rail stops looking like a card

**Purpose:** A sidebar rail and a content card stand on the same paper, in the same frame, with the same 5px between them as between any two cards, so the rail reads as one more card. Give the rail a panel's shape and a wider gutter, and seat both in a small vocabulary — two named lengths, one named treatment, one margin layer — so the treatments the spike rejected for now can be added later without re-plumbing.

---

## Purpose {#purpose}

In the user's words: "Sidebars and the gaps between sidebar cards and content cards *does not look sufficiently different*. I think we might need to stylize the gap, and maybe give the cards more of a distinct visual treatment."

The Rail Distinction spike (`tugdeck/src/spikes/spike-rail-distinction.tsx`) put six treatments side by side on miniature decks. The user chose **E, "Panel, not card"**, with a **12px gutter**: "that would do the job without having to resort to tints or graphical elements in the gutter." The ask is to roll E out, "but do so in a way that will make it *maximally easy* to incorporate other of the A, B, C, D, F options, as well as tinting or graphical gaps appointments should that prove necessary."

So this brief decides two things at once: what E is on the real deck, and where the seams go so that B (tinted rail), C (tinted margin), D (ruled gutter), F (B and C together), and A (today's look, as a fallback) are each a short addition rather than a second rollout.

---

## Evidence {#evidence}

**[F01] The rail's stand-off from the window edge and its gap to the first card are the same number, and that number is the card gap.** `IMPOSITION_GAP_PX = 5` in `tugdeck/src/lib/layout-imposer.ts` is used for all three: the rail's own pin (`imposeSidebarStyle` emits `left: GAP` on the left side and `100% − width − GAP` on the right; `railMemberPins` emits `top: GAP, bottom: GAP_BOTTOM`), the band inset a rail contributes (`resolveSpan` adds `rail.width + IMPOSITION_GAP_PX` per occupied side), and the seam between imposed cards. The deck canvas writes the same arithmetic as CSS: `--tug-imposer-inset-<side>` is `calc(var(--tug-sidebar-width-<side>) + 5px)` in `deck-canvas.tsx` around line 1850, and `deck-manager.ts` lines 3339–3341 repeat it numerically. There is no name for "the rail's edge inset" or "the rail's gutter" anywhere; both are the card gap by coincidence of value. **(verified)**

**[F02] The bottom gap already has the shape the two new lengths need.** `IMPOSITION_GAP_BOTTOM_PROPERTY = "--tug-imposer-gap-bottom"` is a CSS custom property with a numeric twin (`impositionGapBottomPx()`), settled once at boot from the maker-mode round trip, and every emitted `calc()` names it rather than restating a number. The imposer's own comment says why: "the imposer's emitted `calc()` strings state the gap ONCE, by name." A rail edge inset and a rail gutter published the same way inherit the same guarantee that CSS and the numeric twin cannot drift. **(verified)**

**[F03] The rail's chrome is already keyed on attributes the panel shape can reuse.** `TugPane` stamps `data-role="sidebar"` on the pane element from the card's registered `layoutRole` (what the card *is*), and `data-rail-side="left|right"` only while the rail is pinned to an edge; a released rail keeps its role and loses its side (`tug-pane.tsx` around line 4334). The rail tier's rules in `tugdeck/src/components/tugways/tug-pane.css` (lines 384 onward) key on `data-role`. The frame's own shape comes from `--tugx-pane-bg`, `--tugx-pane-border`, `border-radius: var(--tug-radius-md)`, and `--tugx-pane-shadow-*` on `.tug-pane-chrome`. All four are tokens or one declaration, so a panel shape is a scoped override block and not a second frame. **(verified)**

**[F04] The margin cap is already a layer painting canvas ground beside the rail.** `tug-margin-cap` (`tugdeck/src/components/chrome/margin-cap.css`, mounted in `deck-canvas.tsx` around line 3776) covers the 5px a rail stands off the window edge, paints the body's own graph paper with `background-attachment: fixed` so the grid stays in phase, takes the press so no hidden card receives it, and carries the canvas-background marker so the press still deselects. Its width is `IMPOSITION_GAP_PX` written inline from the canvas. Nothing else paints the band a rail stands in. **(verified)**

**[F05] The spike's E row is a flush panel on the sunken surface with one strong inner hairline.** The row's CSS: rail pinned `inset: 0 auto 0 0`; `--tugx-pane-bg` set to `--tug7-surface-global-primary-normal-sunken-rest`; on the chrome, `border-radius: 0`, `box-shadow: none`, `border-width: 0 1px 0 0`, inner edge in `--tug7-element-global-border-normal-strong-rest`. Card gap to the rail from the spike's Gutter slider, which the user set to 12. Nothing about the rail's title bar, stripes, or ink changed. **(verified, in the spike file)**

**[F06] The rail's bottom already clears the maker strip.** `GAP_BOTTOM` resolves to 32px in maker builds (a 27px strip plus one 5px gap of air) and 5px otherwise. A rail that runs flush to the window's bottom in a release build therefore has a different bottom pin from one in a maker build, and the difference is already carried by one property. **(verified)**

**[F07] Tests that pin the rail's arithmetic.** App tests that import `IMPOSITION_GAP_PX`, `resolveSpan`, or `imposeSidebarStyle`: `at0303-imposer-space-allocator`, `at0359-sidebar-stack`, `at0362-height-pinned-imposed`, `at0454-flow-mode`, `at0466-go-to-slot`, and `zz-probe-layout-miniature`, all under `tests/app-test/`. Any that computes a band width or a rail pin from the card gap will need the new names. **(verified by grep; which assertions actually break is for the arc to find.)**

**[F08] Doctrine that describes the rail today.** `tuglaws/pane-model.md` line 187 ("A rail is not a card in the slot band … a flush ground instead of the tinted band") and `tuglaws/design-decisions.md` line 584 (the three chrome tiers; "racing stripes are settled … *do not re-propose*"). Neither says anything about the rail's frame or its gap; both will need a sentence. **(verified)**

**[F09] The keyboard focus ring is drawn on the frame's geometry.** `tugdeck/src/lib/card-ring.ts` mentions sidebar handling and draws the ring around a pane. A frame with square corners and no outer border may want the ring's radius to follow. **Not verified: read the filename and one grep hit, not the drawing code.** The arc confirms it by focusing a pinned rail from the keyboard.

---

## Decisions {#decisions}

**[B01] The rail becomes a panel: flush to the window's top and outer edge, square corners, no shadow, sunken surface, one strong hairline on its inner edge.** This is E as the spike drew it, and it is chosen over B, C, D, and F because shape does the whole job on its own: a rail that is part of the window and a card that floats on the paper differ in kind, which no amount of tint or livery in the gap achieves by degree. The rail's bar, stripes, label, and glyph do not change; the rail tier is settled and this decision is about the frame around it, not the chrome inside it. The rail's bottom edge keeps whatever clearance the maker strip needs: flush in a release build, and in a maker build the strip's own height with no gap of air, because a panel touching the strip reads as the window's furniture meeting other furniture. The arc looks at the maker case and reports if it reads wrong.

**[B02] Two named lengths replace the card gap in every rail expression: a rail edge inset and a rail gutter.** The edge inset is the rail's stand-off from the window edge on its outer side and top. The gutter is the space between a rail's inner edge and the band the cards stand in. Today both are `IMPOSITION_GAP_PX` by coincidence of value [F01]; E sets the edge inset to 0 and the gutter to 12. Each is a constant with a CSS custom property and a numeric twin, exactly the shape the bottom gap already has [F02], and every emitted `calc()` names the property rather than a number. `resolveSpan`, `imposeSidebarStyle`, `railMemberPins`, `RAIL_RUN`, the deck canvas inset effect, and the deck manager's band arithmetic all read the two names. This is the whole of what makes A and D cheap: A is edge inset 5, gutter 5, and D is edge inset 0 with a wider gutter, both without touching an expression. The interior seams of a split rail keep the card gap's half-gap rhythm; they are seams between two members of one panel, not the rail's edge.

**[B03] One named treatment, stamped as an attribute on the deck root, keys every appearance rule.** A constant naming the shipped treatment (`panel` for E) is written once as `data-rail-treatment` on the deck container, and the CSS for a treatment is one block scoped under that attribute. The panel block is the four overrides in [F05], keyed on a *pinned* rail (`data-rail-side` present, per [F03]), so a released rail floating free regains the card frame while it is afloat and keeps its stripes, because a panel is a shape a rail has at an edge and not a property of the card. Adding B, C, D, or F is then: a new value for the attribute, one CSS block, and possibly different values for the two lengths in [B02]. Nothing is a setting yet; a setting is one line away because the attribute already exists, and there is no evidence anyone wants to choose (see Non-goals).

**[B04] The margin cap becomes the rail margin: the one layer that paints the band a rail stands in, from the window edge through the gutter.** Today it covers only the 5px a rail cannot reach [F04]. Its width becomes edge inset plus rail width plus gutter, and it keeps everything it does now: the body's own graph paper in phase, the press swallowed, the canvas-background marker so the press deselects. With E's treatment it is invisible, because it paints exactly the ground it stands on. C paints it a tinted canvas with a tinted grid; F paints it a finer-pitched grid; D draws the rail's three hairlines down its gutter portion. Each of those is a CSS block under `data-rail-treatment` on this one element, which is what makes "graphical gap appointments" a stylesheet change and not a new component. The cap's occluding role is unchanged: a flow card sliding toward the rail still goes behind the margin as it goes behind the rail today.

**[B05] Tint, when a treatment wants it, is two custom properties the treatment sets and the rail and margin read.** A tint hue (`--tugx-rail-tint-hue`, defaulting to the light themes' chrome Key surface and falling back to the focused title bar surface on the dark themes, as the spike does) and a tint strength on 0–1. The rail's ground, border, and the margin's canvas and grid are each a `color-mix(in oklch, <token>, var(--tugx-rail-tint-hue) <strength>)`, declared once, so the panel treatment sets strength 0 and paints the bare tokens, and B or F set a strength and change nothing else. This is decided now, with the strength at zero, because declaring the mix once is cheaper than retrofitting four declarations later and costs nothing while unused. No theme file changes: the hue is derived from tokens the themes already carry.

**[B06] The spike is deleted when the arc lands.** Its purpose was choosing, and the choice is made. The treatments it drew are reachable on the live deck afterwards by changing the one attribute in [B03] from the console, which is a better preview than a miniature. Its findings that outlive it are in this brief.

**[B07] Doctrine gains one paragraph and one decision.** `tuglaws/pane-model.md` § rail says a pinned rail wears a panel frame and names the two lengths and the treatment attribute; `tuglaws/design-decisions.md` records the choice of E over tint and gutter livery, with the same "do not re-propose" the stripes carry, so B, C, D, and F stay as options that were seen and set aside, not as ideas nobody has had.

---

## Open Questions {#open-questions}

- **Whether the focus ring wants square corners on a panel.** [F09] is not verified. If `card-ring.ts` draws a rounded ring on a square frame, the ring should follow the treatment; if it reads the frame's computed radius, nothing is needed. One keyboard focus on a pinned rail settles it.
- **Whether a two-member stacked rail's stack badge and seam still sit right without the outer gap.** The seam and badge geometry are measured from the rail's pins, which move by 5px on two sides. Probably nothing, but `at0359-sidebar-stack` is the test that says.

---

## Non-goals {#non-goals}

- **A user-facing setting for the treatment.** There is no evidence anyone wants to pick among these; the attribute makes a setting cheap if that changes, and a setting today would be a knob nobody asked for.
- **Tinting the rail or the margin now.** Options B, C, and F were seen and set aside by the user: "without having to resort to tints." The mix declarations land at strength zero [B05] so they can return; the strength does not.
- **Drawing in the gutter now.** Option D likewise. The margin layer spans the gutter [B04] so D is one block later.
- **Changing the rail tier's chrome.** The bar, the stripes, the uppercase label, the neutral ink: settled in design-decisions and not reopened here. This brief is about the frame and the paper, not the bar.
- **Changing the card gap.** `IMPOSITION_GAP_PX` stays 5 for every seam between cards and between split members. The two new lengths exist precisely so the rail can differ without the deck's rhythm changing.
- **A rail that is a panel while released.** A rail dragged off its edge is afloat over cards and needs a card's frame to read as a thing that can be dropped; it keeps its livery and regains its frame [B03].

---

## Exit {#exit}

**An arc.** The order that matters is names before shapes, because the shape's geometry is written in the names:

1. Name the two lengths in the imposer with properties and numeric twins on the bottom gap's pattern, and route every rail expression, the canvas inset effect, and the deck manager's band arithmetic through them, still at 5 and 5 so nothing moves. Fix whichever of the [F07] tests computed from the card gap.
2. Widen the margin cap into the rail margin [B04], still painting bare ground, and stamp the treatment attribute on the deck root [B03].
3. Add the panel treatment block with the tint mixes at strength zero [B05], set the edge inset to 0 and the gutter to 12, and look at both maker and release builds, a split rail, a stacked rail, a released rail, and a keyboard-focused rail.
4. Doctrine [B07], delete the spike and its registry lines and drop the taxonomy pin by one [B06].
