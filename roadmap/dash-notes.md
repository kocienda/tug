Notes:
- Lens Session row needs more spacing above dash line
- Lens session row titlwe must take on `#[session-name]. All instances of the session name must reflect the dash name when one is is progress, and lost the dash name when the dash is done/released.
- Dash row in `Dashes` section should show the session this dash is bound to


OK. Consider the roadmap/dash-integration-plan.md. I want to insert a new Phase 2.1. Here's the rub. The current workflow to create a plan that is suitable for `/implement` to work on goes like this:
- I develop an idea interactively in a session. This is good.
- We often produce a brief from this discussion. This is fine too.
- I run `/devise` against either the discussion or the brief. Still OK.
- I run `/vet` against the devised plan, and the result of this vetting is *basically always* me saying: "do the fixups!". This sucks. We need to figure out a way to ball up this vetting and fixup roung with `/devise`. This should be *one step* to produced a divised, vetted, and fixed up plan. We also should *always* use Opus (for now) when vetting and fixups, regardless of what model was used to devise the plan

Make me a proposal for how we can achieve this. Ideally, `/vet` goes away.



| Skill | Rides | Rule check |
| --- | --- | --- |
| plan-devise | tugutil plan | ✓ |
| plan-review | tugutil plan | ✓ (fixes the suffix inversion) |
| dash-implement | tugutil dash | ✓ (unchanged) |
| dash-on | tugutil dash | ✓ (unchanged) |
| dash-audit | tugutil dash | ✓ (unchanged) |
| dash-join | tugutil dash | ✓ (unchanged) |
| draft | tugutil draft | ✓ (unchanged — the namespace is the name) |


OK. All this dash-related work is now in the codebase. This was a big lift to get to the point, but as I pull back and look at the code, it feels like while I hope we have the *infrastructure* to support dashes in the app now, the user experience and user interface has *quite* some way to go before it works smoothly and intuitively.

Just as a start, the use of badges in the UI to name dash branches needs a *ton* of work, both in the errant/ill-chosen placement, and in the implementation to simply show the complete badge with clipping it. ![Screenshot 2026-08-14 at 9.29.57 AM](<assets/Screenshot 2026-08-14 at 9.29.57 AM.png>). We need to think about how to show dashes and session-identity in the title bars of sessions and in the session atoms we show in places like the transcript and the Gazette. The binding to a dash is temporary for sure, but we already dynamically cahnge and update session atoms with custom names when they change, so this is not a structural issue barring us from doing something interesting graphically and informative to the user.

Also, I think a separate *Dashes* section in the Lens was a mistake. We should instead show dashes as an *indented sub-row* under the session bound to it (marked with the lucide `git-branch` icon).

The `Join` route in the Z4A section in the prompt-entry component seems unresolved, as does the prompt we type for joining.

Finally, the user interface to *get into* the dashes workflows still seems entirely driven by hard-to-find and difficult-to-understand slash commands... but OK for now. If we address some of the above issues, then we can circle back on the UI to plan and begin dashes.  


Why did this dash turn into a dotted circle? It's still working! ![Screenshot 2026-08-15 at 8.00.18 AM](<assets/Screenshot 2026-08-15 at 8.00.18 AM.png>)



