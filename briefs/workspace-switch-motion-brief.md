# Workspace switch motion

**Purpose:** A workspace switch is the one gesture still outside the set-up-and-go shape. Its first frame is on time, but then one large React commit lands in the middle of what the user sees as the switch, and the deck stands still for 130–140 ms.

---

## Purpose {#purpose}

The set-up-and-go arcs gave every settle gesture the same shape: pay every cost before the first frame, let nothing land mid-motion, and land in one frame. The workspace switch was left out on purpose. The motion brief's [B08] said it is "its own body of work", to be decomposed with the same instruments before anything is decided. `at0643-workspace-switch-cadence.test.ts` has been intermittently red on `main`. This brief is that decomposition, and the decisions that follow from it.

---

## Evidence {#evidence}

**[F01] The reading this brief is written from.** `tugtool deck motion settle --gesture switch --tasks --chains` was run three times (A→B, B→A, A→B) against a harness deck. The deck was `at0643`'s grown fixture: two workspaces, each with a Workspaces rail, three session cards bound to real resumed transcripts (slice arm) and two text cards. It measured 5,615 elements, 456 stacking contexts and 1,893 render-layer candidates, and was at rest at 0 updates/s. `at0643`'s planted CSS loops were left out, because they fail the verb's at-rest check. The raw output is kept with the arc's documents (`step5/switch-reading.txt`). **(verified)**

The user's release deck could not be read. With the arc's own session running on it, its progress dots and arc marks hold it at 21 updates/s against the at-rest budget of 10, and the verb refuses a busy deck. The user's deck numbers below come from the motion brief's [F07]. Re-reading them on an idle release deck is the first act of the arc this brief opens.

**[F02] The first frame is on time, and the cost lands after it.** Lead from gesture to first frame was 15–20 ms. The longest gap was then 127–140 ms. Main-thread time across the 600 ms window was 122–135 ms, of which React was 120–132 ms. On the user's deck the motion brief recorded a longest gap of 158–414 ms and a React render of 110–121 ms. Same shape, larger. **(verified)**

**[F03] The gap is one React commit, landing 125–139 ms after the gesture.** It performs 1,834 of 4,022 fibers, mounts 6, and takes 108–118 ms. It is asked for by `TugSheetContent`×8, `SessionCardBody`×2, `CardsContent`×2 and `DeckCanvas`. Its causes are `invalidateSpacesSnapshot < _flipFirstResponder` (×43), `touch < setKeyCard < notify` (×30) and `touch < settleKbfEngagement < setKeyCard` (×30). Every other commit in the window is under 10 ms: two `CardsContent`/`DeckCanvas` local-state commits of 1,334 fibers each at 4–9 ms, then small badge and list commits. **(verified)**

**[F04] The commit renders both workspaces, not only the arriving one.** Its why-list names `LayerPanes@at0643-two{shown,deck,arr}` and `LayerPanes@at0643-one{shown,deck,arr}` in both directions, and one session body in each workspace (`at0643-sa` and `at0643-sd`, `[state/ctx]`). The departing layer re-renders on its way out, and that is part of the 1,834 fibers. **(verified, from the why-list; how much of the 108–118 ms belongs to the departing layer was not separated)**

**[F05] The forced layout is inside the commit.** The chain census counted 38 chains over 143 tasks: 117 ms in total, longest 55 ms (a lower bound, because the census truncated). The two largest families are `clientHeight` reads from React's layout-effect path (15 chains, 64 ms) and `scrollTop` reads from the passive-effect path (10 chains, 46 ms). The per-drive split agrees: 83–87 ms of chains are in-commit, and the longest chain outside every commit is 2–3 ms. **(verified)**

**[F06] The switch writes no land record.** No `settle-land` row was written across the three drives, and no `settle-frames` row either. The switch does not go through the settle engine, so the motion gate, the sealed-motion clause and the land record do not apply to it. Its cadence is read only by `space-switch-frames` (`at0643`). **(verified)**

**[F07] The switch's commit is caused by focus, not by the layer swap.** The dominant causes in [F03] are the first-responder flip and the key-card engagement (`_flipFirstResponder`, `setKeyCard`, `settleKbfEngagement`). The layer's own `shown` attribute is DOM and costs no render. **(inference from the cause list; confirmed when the commit is moved or split and its fiber count drops)**

---

## Decisions {#decisions}

**[B01] The switch takes the set-up-and-go shape: prepare, then move, then land.** The arriving workspace's commit is paid before the first frame that shows it, so no commit lands between that frame and the end of the switch. This is the shape every other gesture holds and the user's standing rule: lead is a budget, and a gap mid-motion is the hard bar. A switch whose first frame is late by the commit's cost is preferred to one whose first frame is on time and then stalls. The first is a delay; the second reads as a stutter.

**[B02] The departing workspace renders nothing on the switch.** [F04] shows the parked layer re-rendering on its way out. A parked layer has nothing on screen to update, so that work is moved after the switch or removed. Its share of the commit comes off the lead instead of being paid in it.

**[B03] The focus fan-out is what gets narrowed, not the layer swap.** Per [F07], the work is in the first-responder flip and the key-card engagement re-rendering sheets and session bodies across both workspaces. The fix reads those causes first: why eight `TugSheetContent` re-render on a focus move, and why `invalidateSpacesSnapshot` reaches both layers. The layer show and hide are already cheap DOM.

**[B04] The switch gets the settle instruments.** It closes the motion gate around its first frames, writes a land row, and `at0643` reads the sealed-motion clause and the land the way the settle files do. Today the switch is read by its cadence alone ([F06]), which cannot tell a commit mid-motion from any other gap.

**[B05] Every reading is taken on the grown fixture and the user's release deck, at rest.** The harness reading is the controlled baseline. The release deck is the bar the user sees, and per [F01] it must be read when no session is running on it.

---

## Open Questions {#open-questions}

- **How much of the 108–118 ms is the departing layer's?** [B02] assumes a material share. Splitting the why-list by layer, or a reading with the departing layer's render suppressed, settles it before [B02]'s work is sized.
- **Does paying the commit before the first frame put the lead over budget on the user's deck?** At 110–121 ms React on the user's deck ([F02]), the lead would be over seven display periods unless [B02] and [B03] bring the commit down first. Whether a long-lead switch is acceptable while the narrowing lands is the user's reading to make, on their deck.

---

## Non-goals {#non-goals}

- **Animating the switch.** The switch is a cut: one layer is shown and the other parked. This brief puts the cut's cost in the right place. It does not add travel.
- **Planting loops in the reading.** `at0643`'s CSS loops measure the compositor under load, and they belong to that test. The decomposition is read at rest, or the verb refuses it.
- **Building anything in the arc that wrote this brief.** The set-up-and-go-fixups arc only reads and briefs the switch, by its own [B08].

---

## Exit {#exit}

An arc. Its first act re-reads the switch on the user's release deck with no session running ([B05]). Then the departing layer's render comes out ([B02]), the focus fan-out is narrowed ([B03]), and each lands with a reading before and after. The gate and the land row ([B04]) go in before [B01] moves the commit, so that `at0643` can see the commit move. Done when `at0643` reads no gap over one display period after the first frame, a one-frame land, and a sealed motion on both the grown fixture and the user's deck.
