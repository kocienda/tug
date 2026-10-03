# The arc verb row

**Purpose:** The three surfaces that show an arc offer different verbs in different forms. Some are icons, some are words, and some sit behind a right-click or a ⋮. This brief settles one verb set, in one order and one form, for all three.

---

## Purpose {#purpose}

Three surfaces display an arc: the Arcs sidebar card, the Z2 ARC status popup, and the Changes shade's "arc bound to this session" lane. Each wears the same `ArcLifecycleBlock`, and each arranges the commands around it its own way. In the user's words: *"The goal is to make the commands to manipulate the arc more consistent and visible/legible. I don't like the vertical hamburger menu in the Changes shade. The buttons elsewhere are sometimes icons and sometimes words."*

`spike-arc-commands` (`tugdeck/src/spikes/spike-arc-commands.tsx`) compared four treatments over all three surfaces in four arc states:

- **As shipped**: today's arrangement.
- **Verb row**: every verb visible.
- **Act + Arc ▾**: the next step and the view visible, housekeeping behind a labelled menu.
- **Icons**: every verb as an icon.

The user chose **Verb row**, without reservation.

---

## Evidence {#evidence}

**[F01] Stop/Resume appears in two forms and is missing from the third surface.** **(verified)**
- On the Arcs card, `ArcTransportControl` renders `form="icon"`: a bare ■ or ▶. See `tugdeck/src/components/arcs/arcs-card.tsx`, around line 850.
- The ARC popup renders it `form="word"`, as an outlined "STOP" or "RESUME". See `ArcPopoverContent` in `tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx`, around line 1460.
- The Changes lane (`session-changes-arc-lane.tsx`) has no Stop/Resume control at all.

**[F02] The housekeeping verbs are hidden, differently on each surface.** **(verified)**
- Both hidden routes build Bind/Unbind, Discard and Replay from `useArcRowMenu` (`tugdeck/src/components/tugways/cards/session-changes/arc-row-menu.tsx`).
  - On the Arcs card the only way in is a right-click on the row, with no visible opener.
  - In the Changes lane the way in is a ⋮ (`EllipsisVertical`) button.
- The ARC popup offers none of these verbs.
- On the Arcs card a bound row omits Unbind (`binding: null`).

**[F03] Two more one-off controls duplicate menu verbs.** **(verified)**
- The Arcs card's branchless plan row has its own `PlanDeleteButton`: a `Trash2` icon that sends `changeset_delete_documents`.
- The Changes lane's branchless `DocumentArcRow` has its own text "Unbind" button.

**[F04] The view verbs differ by surface.** **(verified)**
- The ARC popup's footer has a ghost "Show in Changes" (`REVEAL_CHANGES`).
- On the Arcs card, clicking the row does the same thing, but only when the bound card is open.
- The Changes lane has a pop-out icon (`PopOutDiffButton`, `OPEN_DIFF` range) for the arc's diff.

**[F05] Join can't be reached from any arc surface.** **(verified)** It is reached only through the composer: `/arc-join`, ⌃⌘C, or the Changes row's fold, which "aims" the join face. No arc row carries it.

**[F06] Refusals already have a house form, and it should carry over.** **(verified)**
- `ArcTransportControl` never DOM-disables a refused verb. It sets `aria-disabled` and `data-refused`, and a press posts the reason.
- Menu items carry their reason in the label (`arcRowMenuLabel`: `Replay onto main — already current with main`).

**[F07] At sidebar width the verb row wraps.** In the spike's 360px Arcs-card frame, a row of five or six icon-and-word buttons breaks onto a second line rather than truncating. This was observed in the spike, not measured against the real sidebar.

---

## Decisions {#decisions}

**[B01] Every arc surface shows one verb row, under the block.**
- The row is a run of its own beneath the `ArcLifecycleBlock`. On the ARC popup, the footer *is* that row.
- Every verb the arc currently offers is visible. None of them hides behind a menu.
- This makes the commands visible and legible, which is the whole of what was asked. The two menu treatments in the spike were the alternatives, and the user rejected them.

**[B02] The order is fixed once, the same on all three surfaces:**
1. **The arc's next step.** Its button is outlined; every other verb is ghost.
2. **The view.**
3. A spacer, which pushes the housekeeping verbs to the trailing edge.
4. **The housekeeping verbs:** Bind or Unbind, then Replay onto main, then Discard.

The fold cue stays where each surface already seats it, at the block's trailing edge. One order is what lets a reader who has learned the row once find a verb on any surface without looking.

**[B03] Every verb is drawn as icon plus word.** Words on their own, or icons on their own, are not used. This ends the icon-here, word-there split in [F01].
- The buttons are `TugPushButton size="2xs" subtype="icon-text"`. Discard has `role="danger"`.
- The spike's icons are the starting set:

  | Verb | Icon |
  |---|---|
  | Start | `Play` |
  | Stop | `Square` |
  | Resume | `Play` |
  | Join | `GitMerge` |
  | Show in Changes | `GitCommitHorizontal` (the shade's own glyph) |
  | Diff | `SquareArrowOutUpRight` |
  | Unbind | `Link2Off` |
  | Bind | `Link2` |
  | Replay | `RotateCcw` |
  | Discard | `Trash2` |

**[B04] The first slot holds whatever the arc's state names next.**
- That is Start for a briefed arc, Stop while it runs, Resume once stopped, and Join when it is ready to join. A finished or joined arc leaves the slot empty.
- `transportFace` (`tugdeck/src/lib/arc-transport.ts`) already answers this for Start/Stop/Resume. Join extends it for the ready case.
- The Changes lane gains Stop/Resume, which closes the gap in [F01].

**[B05] Join becomes reachable from an arc row.** It invokes the same join `/arc-join` does: one join verb with two doors, never a second join path. ([F05] shows today's state.)

**[B06] The view slot names what it will open.**
- On the Arcs card and the ARC popup it is **Changes**, which reveals the bound session's Changes shade. That makes the Arcs card's row-click behaviour visible as a button.
- In the Changes lane it is **Diff**, which opens the arc's range diff in a card. That is today's `PopOutDiffButton` on the arc row.

**[B07] Discard also covers a branchless arc.**
- On an arc that has no branch, Discard does what "Delete documents" does today. It is the same act on an arc that has nothing else to lose, so it wears the same word.
- `PlanDeleteButton` and `DocumentArcRow`'s standalone Unbind button are removed, and their verbs move into the row ([F03]).

**[B08] The ⋮ in the Changes lane is removed.** The Arcs card's right-click menu stays as a second door to the same housekeeping verbs. It is never the only door: it is a shortcut over buttons that are already visible.

**[B09] Reach and refusal rules are unchanged; only the presentation changes.**
- A verb a surface has no business performing is still absent. For example, Discard is absent outside `canDiscardFromHere`.
- A verb the arc's state refuses is shown with `aria-disabled`, `data-refused`, and its reason in the tooltip and accessible label ([F06]). It is never DOM-disabled.
- One rule changes: the Arcs card's bound rows gain Unbind, so the binding verb reads the same on every surface ([F02]).

**[B10] One component, one derivation.**
- The three surfaces consume one shared `ArcVerbRow`, fed from one function that derives the verb set from the arc entry, the surface, and the reach inputs.
- The current drift happened because each surface assembled its own controls. A single derivation makes it impossible for that to happen again.
- `ArcTransportControl`'s wire behaviour (`arc_run` / `arc_resume` / `arc_stop`, actor resolution, the press store) is reused, not re-implemented.

**[B11] At narrow widths the row wraps; it never truncates or collapses into icons.** The second line at sidebar width ([F07]) is the accepted cost of keeping every verb legible.

---

## Open Questions {#open-questions}

- **Which session performs a Join started from the Arcs card?**
  - The composer's join runs in the session whose composer it is, and lands that session's draft.
  - An Arcs card row has no composer. The answer is probably the bound session, refused with a reason when the arc is unbound or its card is closed.
  - Settling it means reading how `changeset_join` and the join face pick their session.

---

## Non-goals {#non-goals}

- **A labelled "Arc ▾" menu for the housekeeping verbs.** The user rejected it in the spike in favour of everything visible.
- **An icon-only strip.** It is what the Arcs card does today, applied everywhere, and it fails "legible", so the user rejected it.
- **Changing what DOCUMENTS, ROUNDS, or the join report show** in the Changes lane. Their own controls (Resolve, Undo, the per-cluster pop-outs) are not arc-row verbs, and this brief does not touch them.
- **Changing the `ArcLifecycleBlock`'s two lines.** The row sits under the block. The block's promise not to grow stays intact.
- **New verbs beyond Join.** Review, open brief, and open plan stay where they are.

---

## Exit {#exit}

**An arc.** Its rough shape:
1. Build the verb derivation and the `ArcVerbRow` component, reusing the transport wiring and `useArcRowMenu`'s perform callbacks.
2. Seat the row on each surface:
   - Arcs card: remove the line-trailing transport.
   - ARC popup: the row replaces the footer's two buttons.
   - Changes lane: remove the ⋮ and the arc row's pop-out.
3. Fold `PlanDeleteButton` and `DocumentArcRow`'s Unbind into the row.
4. Add Join, once the open question above is settled.
5. Update the app-tests that address the retired controls by `data-slot`, such as `session-changes-arc-row-menu-open`. Those tests must change along with the controls; they are not pins to work around.
6. Delete `spike-arc-commands`, since this arc is its graduation.
