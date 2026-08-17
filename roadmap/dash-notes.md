Now, next... let's look at the Dashes section in the Lens. My first question is... do we really need this separate section. I tend to think that maybe we don't. I think that we should probably improve the Sessions section and the information we give in the session card in the Cahnges shade for a dash in progress. What do you think? Should we drop this second Dash-only section? As a counterpoint to my suggestion: argue the other side and defned keeping it and how we could improve it to make it truly distinct and useful.



Now, next... Let's make general changes to the Changes sheet:
- I want to move the large `X` button in the Z5 area and move it to the top right of the shade, in a position similar to many of the other `x` buttons in the app. This button should shrink in size and the current tiny/small diff button should grow up a little bit, so that both match the size, placement, and style of right-side buttons in card headers. get what I mean here. This will lay the groundwork for coming changes to the Changes shade when we are showing the changes for a dash. For now, make this update for all cases of the Changes shade.
- The headers we have now for the different kinds of changes and for dashes are clear and legible, but fall short of the graphical quality I aspire to the rest of the app. Let's do a mini design spike via a gallery card to improve how these sections look in the Changes sheet. The gallery card should include a full inventory of the sections we show for all the different kinds/states we display in the Changes shade. One change for sure: *banish the possessive*; no apostrophe `s` in these headers for any topic/header.


The header in the Changes shade when showing a *dash* is a jumble of buttons and badges. This is *comically bad*. We need a mini spike to design a gallery card with better information and controls.


**The blue JOIN button is `enter()` — mode entry.** It aims the dash, runs a preview, flips the composer's route to Changes, and seeds the join draft. That's all it has ever done. And when you're *already* in join mode aimed at that dash — which you were, every time — pressing it re-enters the mode you're in: one more preview, zero visible change. The flash was the button; the "nothing" was the system agreeing with itself that you're where you already are.

And yes — you're right, and I'll say it in your own design vocabulary: **this is a verb misassignment, which is the worst class of UI defect this project has.** Not a dead control, not a silent refusal — a control wearing the name of the act while performing *orientation toward* the act. Every round of hardening attacked the wrong layer because the layers below were genuinely guilty of other crimes: the gate swallowed refusals (fixed), the staged exit dropped the target (fixed), the receipts didn't exist (built). Each fix was real. None could help, because the request you were making was never entering the funnel any of it guards. Meanwhile the true landing gesture is an **unlabeled up-arrow sitting in the send button's chair** — the one position on the whole surface whose icon has a settled, different meaning.

The bitter grace note: this very file already knows the lesson. `session-changes-dash-landing.tsx:288` — *"A disabled button takes no pointer events, so a `title` on one can never be read — the reason has to arrive as face text or it does not arrive at all."* The surface learned to speak its refusals out loud. It never learned to say what its buttons *do*.

The fix is a design call and it's yours, but the space is small:

1. **The word goes on the act.** The composer's land button stops being an anonymous ⬆ and wears `LANDING_WORDS` text — "Join" / "Commit" — it's a different act than send and must not share send's face.
2. **The row button either lands or visibly hands off.** Cleanest: when the mode is already entered and the gate is ready, the row's JOIN *is* the landing (one gate, one funnel, same `land()`). Or it relabels to what it does — "Write join message" — and pressing it while already aimed drops focus into the composer instead of no-oping.
3. **Re-press must never be a silent self-agreement.** `enter()` on an already-entered target should at minimum pulse the composer. The no-change no-op is the same resting-lie family as everything else you've outlawed.

Meanwhile: `synopsis` is on `main` as `698ed3910`, and the log shows `prompt-history` aimed and previewing clean at 20:36 — you're one ⬆ press away in the `toasty-tuna` card from landing the second one. Probes are still armed; I'm watching. I'll revoke the `diag/eval` opt-in once we're done here.

Let me also correct the record in my memory — the "join dead-press FIXED" note is now wrong in an important way:

The record is corrected. To close the loop on your question in one breath: **the JOIN button opens the join; the arrow performs it.** Two months of "dashes are broken" compressed into that sentence — the machinery was landing-ready the whole time, waiting behind a button that never told you it wasn't the one.

Whenever you're ready: press ⬆ in `toasty-tuna` and `prompt-history` joins too. Then the design round — putting the word on the act — is the real fix, and it's a small one.




-----

OK. Our job now is to start improving the experience and user interface related to dashes and joins. We have a lot of work to do. I have *many* notes, but let's start with one area of work at a time. starting with: the Lens display...

- The Lens display for a dash in progress should be the session name with the #-sigil'ed dash name appended. The third line beneath the session identity (fourth line overall) should describes the plan step we are currently working on. The current dash name listing in this extra/fourth line should be removed from this location.

-  Similarly, we seem to have some ill-conceived/half-broken manner for showing the state of a dash (working/paused/etc.), but this must be made more correct, accurate and robust (one of my dashes got stuck in paused mode when asking me a question and then got stuck in that state even after I answered). 

- Both of these points indicate two specific concepts that I wish to *stress*:
    - 1. The session identity name & atom must *always* show the biound dash for that session with the #-sigil when there is a bound dash to that session. This is true in all places in the UI. No exceptions.
    - 2. The plan step numbers for dash plans must truly become a *first-class* element in the system. Right now, it feels like a convention we ususally honor (which is great), but we must do *even better*. A dash plan without plan numbers is a broken plan and dash, and we can't allow that.
