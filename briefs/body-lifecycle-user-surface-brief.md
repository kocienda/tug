<!-- brief-skeleton v1 -->

# What the user sees of a dormant or evicted card

**Purpose:** Stages 1 and 2 of `briefs/body-lifecycle-program-brief.md` make a hidden card's page go quiet and then go away while its session works on. The user must never see a card that looks dead, stale or lost because of it, and must be able to tell what their background work is doing from the shell alone. This brief decides what a dormant or evicted card shows, where, and what a reveal may show for the half-second it takes.

---

## Purpose {#purpose}

The user: a user "can set up a series of sessions, kick off some work, and then switch their attention (and perhaps the active workspace) to something else." When they come back, the card must read as the same card, caught up, and nothing in between may suggest the work stopped.

---

## Evidence {#evidence}

**[F01] A card's facts outlive its body.** `card.facts` is not `clearOnDetach`, so the shell keeps the last masthead facts (title, phase, telemetry) a body published after the body detaches (`bus/declarations/card.ts`). But they are the *last the body saw*: a dormant body publishes none, and an evicted one has no page to publish from. The phase dot a parked card shows would freeze at whatever it was. **(verified, read)**

**[F02] The shell hears every session's state without a body.** `SESSION_STATE` and the session-scoped feeds reach every page by its subscription; the shell's `sessionSettled`, the Overview and Cards cards' all-sessions stores (`every-card-a-body-brief.md` [F02]) read tugcast's session state, phase and turn facts directly, not through the card's body. **(verified, read)**

**[F03] The reveal is under half a second, and the lid covers it.** `at0749`: kill → visible 419–463 ms, → settled 470–500 ms. The arrival lid (row 1 of the grounding bar) shows the card's chrome at once and its content once painted, with no frame of canvas. **(verified, measured)**

**[F04] Where a card's chrome is drawn.** Since [D216] a card's page draws its own title bar and masthead; the shell draws nothing over a card. A card with no page has no chrome unless the shell stands something in for it, which it does only for a failed body (the lid with a Reload). **(verified, read)**

---

## Decisions {#decisions}

**[B01] A dormant or evicted card's masthead follows the session, not the body.** The shell derives the facts it shows for a card whose body is dormant or gone — phase, the progress dot, the turn count, the last activity — from tugcast's session state ([F02]) rather than from the frozen `card.facts`. A dormant body's own page, when it is shown again, takes over as it does today. So a parked workspace's card still shows its session turning in the Cards rows and the Overview, and a tab's dot in a shown pane still ticks while its body is dormant.

**[B02] An evicted card in a shown position shows its chrome from the shell's stand-in, the moment it is placed.** The placement is always ahead of the arrival: the shell's stand-in paints the title bar and masthead from the derived facts of [B01] for the interval before the page paints, exactly as the lid does for a failed body, so a workspace switch onto evicted cards shows every card's title at the first frame and the content inside the arrival bound. This is the one place the shell paints a card, and it is the lid's existing case extended, not a new surface.

**[B03] Nothing names the tier to the user except the Layout card.** No badge, no dimming, no "parked" label on a card or in a list. A dormant or evicted card looks like any card that is not in front; the Layout card's Bodies row (stage 2 [B05]) is where the state is read by someone who wants it. The tiers are an implementation of "the work goes on", and showing them would suggest it might not.

**[B04] A reveal may show one thing, and only when it must: the arrival lid.** A dormant reveal shows the standing DOM and the missed turns land into it; if stage 1's reading says stale content shows for more than a frame, the lid covers the catch-up. An evicted reveal is always lidded, as any arrival. No spinner, no "restoring…" text, no placard: the restore path's own `SessionRestoring` state stays for a session that has to spawn, not for one that is running.

**[B05] A cold reveal that fails shows the failed-body placard, with Reload.** The one failure a user can see is the path that exists: a body that never reports ready hands back to the shell, which shows the lid with Reload. Nothing new is invented for eviction; the message says the card is reloading, never that work was lost, because none was.

**[B06] Workspace switch, scroll and fold read as they do today, held to their rows.** Row 10 (workspace away and back), row 14 (fold) and the stack's scroll rows run against dormant and evicted cards; their bars are unchanged, which is the point.

---

## Open Questions {#open-questions}

- **A dormant card's draft.** The composer's text stands in the dormant page's DOM and in the bag on eviction; a user who typed in a card and parked its workspace expects the draft on return. Held by row 11's draft rows against both tiers; whether a dormant body should save its bag on going dormant (so a crash while dormant loses nothing) is decided there — likely yes, it is one write.
- **Should the Cards rows show "caught up to turn N" for an evicted card?** Probably not ([B03]); asked here so it is a decision rather than an omission.

---

## Non-goals {#non-goals}

- **A visible "parked" state on cards.** Rejected by [B03].
- **A restore progress affordance for a running session.** The session is running; there is nothing to restore but a view.
- **Changing the Overview or Cards cards' data sources.** They already read the sessions.

---

## Exit {#exit}

**An arc**, after stages 1 and 2 have landed. In order: the derived masthead facts for a bodiless card and their rows in the Cards and Overview; the stand-in chrome at placement with row 1's bar; the dormant-draft row and the bag write on dormancy; the lid rule for a dormant reveal from stage 1's reading; the rows of [B06] against both tiers.
