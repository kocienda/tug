/tugplug:plan-devise The dash paperwork directory (briefs + plans) must stop being a culturally-blessed name and become a per-project config key. Add `docs` under `[tugtool.dash]` in `.tugtool/config.toml` (schema: DashConfig in tugrust/crates/tugutil-core/src/config.rs), with a resolver verb (`tugutil dash docs-dir`) that reports the configured directory, and an unset-behavior contract: skills that need the directory ask the user once, write the answer into config, and never ask again. Update the tugplug skills (plan-devise, plan-review, dash-implement) to resolve the directory through the verb instead of asking every time or naming roadmap/. Then migrate this repository: set docs = "dash", move roadmap/ (13 live files plus roadmap/archive/) to dash/, and update every cross-reference in tuglaws/ and CLAUDE.md in the same pass. Also sweep human-facing UI copy for `tugutil` mentions — a human surface must never name the internal tool (known instance: the Dashes empty state in tugdeck/src/components/lens/sections/dashes-section.tsx, "No dashes. tugutil dash create starts one." — give it interim human copy; a real affordance replaces it in a later phase). Keep `.tug/` (worktrees, workshops) exactly as it is — that decision is settled, machine area stays put. 🢂 roadmap/dash-docs-home.md


/tugplug:plan-devise Formalize the dash paperwork formats, in two halves. First, write tuglaws/brief-skeleton.md — the brief format is currently unspecified. Keep it deliberately lighter than the plan skeleton: a brief captures decisions before a plan exists, it is not implementable. Proposed required sections: Purpose (the problem in the user's words), Evidence (what was observed or measured), Decisions (labeled [B01]… so plans can cite them), Open Questions, Non-goals, and Exit (what the brief expects to spawn — a plan, a spike, a wontfix). No linter yet — the format should survive several real briefs before anything calcifies it. Second, audit tuglaws/devise-skeleton.md against reality: diff its claims against what `tugutil plan lint` actually enforces (drift in either direction is a bug — the linter is what the format means), survey the existing plans in the docs directory for skeleton elements no real plan ever uses or that are used only vestigially, and prune or demote them; fold in what recent runs taught (Review Record + stamp discipline, the step ledger living outside the content hash, the --through arming contract). The audit's deliverable is the revised skeleton plus a short record of what was pruned and why. 🢂 dash/paperwork-formats.md


/tugplug:plan-devise Create the single conversational on-ramp for dash work: a tugplug orchestrator skill invoked as bare /dash. Today starting a dash requires knowing five commands and their order (brief authoring, /tugplug:spike-card, /tugplug:plan-devise, /tugplug:plan-review, /tugplug:dash-implement); the user should need to know one name. /dash takes a free-text idea, converses to sharpen it, decides brief-or-not with the user, devises the plan (delegating to plan-devise's contract), stops hard at the review gate — the review runs as its own turn so the user can put it on their preferred model, exactly as plan-devise's Opus/other-model fork already works — and then carries the reviewed plan into dash-implement. Each existing skill remains independently invocable as the expert path; /dash sequences them and owns the connective narration. Name reclamation is part of the work: "dash" is currently registered in LOCAL_SLASH_COMMANDS (tugdeck/src/lib/slash-commands.ts) as a retired spelling deprecated-for dash-bind — remove that entry so bare /dash passes through the three-tier classifier (tuglaws/slash-commands.md) to claude and resolves to the skill; verify namespace canonicalization resolves the bare form to the tugplug plugin skill unambiguously. The skill reads the docs directory through `tugutil dash docs-dir` and writes briefs/plans against the skeletons in tuglaws/brief-skeleton.md and tuglaws/devise-skeleton.md. 🢂 dash/dash-on-ramp.md


/tugplug:plan-devise Make dashes findable and visible without typing anything. Two surfaces. First, the Lens Dashes section (tugdeck/src/components/lens/sections/dashes-section.tsx) becomes the dash cockpit: an always-visible section (no more coming-and-going), multi-line rows carrying dash state, step progress, and a reference back to the bound session — building on the existing design-spike treatment for graphical numbered-step progress. Its empty state gains a real affordance: "Start a dash…" opens a small sheet (name + idea sentence) that does not run tugutil — it submits a prompt into the bound session invoking the /dash orchestrator skill, so buttons produce prompts and the model runs the arc. The section also lists reviewed-but-unadopted plans found in the configured docs directory (resolved via `tugutil dash docs-dir`), each with its next-gesture affordance, so the front half of the arc (brief → plan → review → adopt) is machine-visible the way the back half (implementing i/N → ready → join) already is. Second, the Z2 masthead cell: the TASKS cell in SessionTelemetryStatusRow (tugdeck/src/components/tugways/cards/session-card.tsx) already shows plan steps; when the bound session is driving a dash, relabel it DASH, show the dash name with (i/N) riding the existing step display, and make the click open the dash's cockpit detail. Neither element changes height. No new bar and no third Z4A route tab — those are settled non-goals. 🢂 dash/dash-cockpit.md







OK. We've done all the oustandinding work I have on my list for dashes and joins. I'm quite sure there will be more to do to improve the experience as we go. BUt for now, I want to start thinking about ways to make the dash process more ergonomic, findable, and visible to the human dev. Right now, dashes are created by orchestrating a set of slash commands. To do so requires the *full knowledge* of what these commands are and how/when to invoke them. Also, the *on ramp* to these slash commands varies from job to job. Basically in every session I start off by chatting with you about a project idea of some sort, then I proceed through the following phases, I ask you to:

- Write a document/brief to the `roadmap` directory (sometimes).
- Create a design spike card with `/tugplug:spike-card` (sometimes)
- Run `/tugplug:plan-devise` to create the plan.
- Run `/tugplug:plan-review`, because I set a model constraint to run the review on Opus
- Run `/tugplug:dash-implement` to create and proceed on the dash with the planning document.

There are quite a few issues here I would like to address:
- The name of the `roadmap` directory and our reliance on it was never mean to be like it is. I picked this name off the cuff one session months ago, and not it seems like a decided piece of well-established infrastructure, and it simply isn't that. We need a new name for Tug, and what's more, this name should be whatever the user decides to make it for their project. There must be no *specially-blessed dash directory name* like this.
- The `.tug/worktree` directory is similarly a product of an evolutionary step rather than a settled design. I want to think about this more too. Where should these worktrees go? Can we do better?
- Should *both* of these directories be renamed to something like `dash` or `.dash` or go in a directory whose parent is a *dash* name of some sort?
- The *brief* file format is unspecified. We should write something down and formalize more than we have.
- The *plan* file format/example was last audited a couple of months ago (as I recall). We should give it a solid once-over again.
- Most importantly, the creation of a dash is a *manual process* that requires too much built-in knowledge of these skills. We need to think about how we could better prompt and expose the notion of a *dash* as a great way to actually use git worktrees well in Tug, while avoiding many of the usability pitfalls and complications that result from using worktrees *by hand*. We must do better than this. ![CleanShot 2026-08-23 at 14.34.30@2x](<assets/CleanShot 2026-08-23 at 14.34.30@2x.png>). I will never expect a user to type a `tugutil` command themselves—this is an internal tool for the machinery and the models, not for human devs.

Now, in addition to these naming and architectural cleanup jobs, I want to think about creating a set of user interface affordances that expose dashes, and help users to create them. Maybe a new bar somewhere? Maybe a new DASH Z4A route tab? We have made some progress over the past few days by improving the pulsing-dot indicator to show plan steps, and we now do better at displaying the plan steps in the session masthead and in the Lens. We have to be even more and do it all better. One area we should consider is the TASKS tab that I just simplified down so that it *only shows* plan steps (as separate from JOBS). This seems like an area that could be supplemented to show more information about dashes.... maybe? Maybe the label could swap to DASH when we're on a dash? Something like that?  

OK. This is a lot. Think about this. Break this down. Make a comprehensive proposal, then we can discuss it.




/tugplug:plan-devise The join offer's chrome must agree with the composer route. Two defects, one decision: (1) the Changes shade's quiet-moment reveal (session-card.tsx, the revealedOffersRef effect near line 3500) deliberately "enters no mode and touches no composer" — but that leaves the composer's route segment on Prompt while the shade shows the join room, so the surface that can act on the offer is a manual segment-click away. The composer route should follow the shade both ways: reveal (passive effect AND the explicit revealChanges path) flips the route to Changes, closing the shade restores Prompt. This is safe because the reveal's own gate already holds — no turn in flight, empty composer — so there is no keystroke to misdirect; entering the landing mode and pressing ⬆ stay the user's gestures. Amend [D152]'s "touches no composer" reading to route-is-chrome-not-content and record the decision. Mind revealedOffersRef being mount-local ([L22]): route-restore needs the same key discipline so a reload mid-offer doesn't strand the composer in Changes with no shade. (2) tug-prompt-entry.tsx mounts DashJoinRegisterView in the composer status row whenever the join-mode controller has a register — including on the Prompt route, where the BlockHeader chrome reads as a stray tool-call pill above the prompt. Gate that mount to the landing surface (mode active or narrating); on the Prompt route the Changes segment's accent dot and the shade already carry the offer. Cross-check tuglaws (L02/L06/L22) and the register's three-surfaces contract in lib/dash-join-register.ts before writing steps. 🢂 dash/join-offer-route.md


/tugplug:plan-devise A submitted join must show progress from the instant of the press — today there are several silent seconds between the ⬆ and the durable receipt. The narration plumbing exists end-to-end ([P03]: join_in_with_progress in tugdash-core/src/ops.rs fires squash/teardown/release/record beats, agent_supervisor.rs forwards changeset_join_land_delta, ChangesetJoinStore holds them, dashJoinRegister renders "Joining X into Y — <beat>"), so the plan starts with a diagnosis step: reproduce a real join with the deck trace and pin why nothing showed — the two live suspects are (a) the first beat is `squash`, which fires only after occupancy/preflight/spawn, so the front of the run narrates nothing by construction, and (b) the surface actually on screen after the press may not mount the register at all. Then fix both ends: the server emits an immediate first beat (requested/preflight) the moment the handler accepts the press, before spawn_blocking; JoinModeController.land() writes an optimistic local beat at press time so server latency can never produce a dead frame (the terminal-beat-settles logic in changeset-join-store.ts is the precedent — extend the same principle to the front); and whichever surface the repro shows register-less gets its mount fixed. Fold in the diagnosis of the pre-existing at0405-changes-dash-lane timeout (waits on session-changes-dash-draft, red on main) — it is plausibly the same surface question. BEAT_WORDS gains the new beat(s); keep the one-vocabulary rule the register documents. 🢂 dash/join-narration.md


/tugplug:plan-devise A join is a commit on the base, so its receipt must ride the same Git Commit mechanism as a regular /commit — plus three small run-ending mechanics fixes found in the same audit. The receipt: today format_commit_summary (tugcast/src/feeds/changeset.rs) carries a files: JSON line and renders through the Git Commit path (GIT_IDENTIFIER in session-card-transcript.tsx, commit-block.tsx — sha pill, message, per-file rows with expandable diffs), while format_join_summary carries no files line and renders through the bespoke SessionJoinReceiptBlock. Unify: format_join_summary gains the files: line (the join already holds its range diff), and the join receipt renders through the commit presentation with the dash → base identity as one added line; SessionJoinReceiptBlock thins to parse-and-delegate or retires. Restore parity is contractual: live append and JSONL replay render byte-identically, and receipts already written in the old format keep parsing forever (the discard block's historical-header pattern is the precedent). The mechanics, each one step or less: (1) the arming race — closing the final step arms the arc, whose preflight commit (ops.rs, "join: commit outstanding changes") raced a live tugutil dash commit and killed it on index.lock; both sides retry briefly on index.lock, and the preflight's machine commit either wears the round voice or yields to a live dash commit — it currently also shows in the shade's ROUNDS list as a peer of real rounds; (2) tugutil dash replay on a deferral exits 1 while its JSON says status ok / outcome deferred — pick one meaning (deferral is a non-error outcome, exit 0) and pin it. 🢂 dash/join-receipt-mechanics.md








The join-arc at the end of the work to implement a dash still needs major work. My notes:

- We are not communicating anywhere near the extent that we need to. We strand the user at the ned of the dash steps, while we freaking *build and test again*, when basically every dash ends with a build/integration/test step. WE MUST STOP THIS. It adds a multi-minute process to the end of a dash implementation that provides *utterly dubious value*. We just build and test again exactly what we just built and tested. And for sure, the app-tests are a F&*%^#$ ***boat anchor***. We must not gate dash joins on these test runs beyond what we do while implementing the dash plans themselves. WE MUST NOT tack on more app-tests as a gate to the join process.
- When the join dialog presents itself, and if I choose join, we give *no indication* or either progress or success. The user is left *wondering* what happened, and whether the dash joined or not.
- Sometimes the session doesn't present the join dialog at all, especially when we've implemented a miletsone in a multi-milestone dash plan. 
- Other times, and the end of some dash implementation work, the model instead offers the `dash-join [foo]` chip instead of the dialog. 
- I saw this in a session just now... WTF does this even mean: "One thing to know: `tugutil dash step` warned each time that it **could not bind this session to the dash**, because this session works the base checkout.". This seems utterly confused. The tools need to be more supple. And then.... this again: "**One thing I should flag.** `tugutil dash bind` refused with *“session … works /…/tugtool — it cannot bind a dash in /…/worktrees/step-consistency”* when I ran the step verb from inside the worktree. That’s the cross-project guard from the last arc doing something slightly wrong: it compares the session’s project against whatever root the verb resolved from, and running inside a worktree makes the worktree look like the project. Binding from the repo root worked. The dash was unbound for its first two steps because of it, which means the join arc wouldn’t have piloted it. It’s a real gap in the binding work, not this plan’s — worth its own fix."




The yellow dash name *must be banished*. I have no idea what this is trying to communicate. 



OK. I want to pull back on this dashes work and discuss terminology and typography. Two main points:
- I don't like *parked* or *leave*. Instead, I want dashes to be bound/unbound to sessions, and to have the verbs be bind/unbind. Make these changes up and down the code. Comprehensive update. No lingering *parked* or *leave*. Any issues with this?
- I want to reconsider the `#` sigil. We should use a different character, mostly because we already use the `#` for message numbers in the transcript. I suggest either `◊` or `∫`. What do you think?




OK. We need to go back to this fourth/dash row in the Sessions section of the Lens. It needs improvement. Basically, showing only the state of the dash in tiny little font size with no mention of the total number of steps or the step number being work on now. 

Look back at #u10 for in this session.

> Similarly, we seem to have some ill-conceived/half-broken manner for showing the state of a dash (working/paused/etc.), but this must be made more correct, accurate and robust (one of my dashes got stuck in paused mode when asking me a question and then got stuck in that state even after I answered).
> 
> Both of these points indicate two specific concepts that I wish to stress:
> 
> The session identity name & atom must always show the bound dash for that session with the #-sigil when there is a bound dash to that session. This is true in all places in the UI. No exceptions.
> 
> The plan step numbers for dash plans must truly become a first-class element in the system. Right now, it feels like a convention we ususally honor (which is great), but we must do even better. A dash plan without plan numbers is a broken plan and dash, and we can’t allow that.

Basically, we acted on the first concept (The session identity name & atom must always show the bound dash for that session with the #-sigil when there is a bound dash to that session), but totally and completely flubbed the second. There's no mention *at all* of the steps or step numbers. We need this, and we need to improve the typography: font size, spacing, indent, the lot. The total step number and the currently-executing step must be made visible in this fourth dash-specific session row.


Once we do this, we need to spend a little more attention on the first row, the session identity, specially when it comes to the possible need to ellipsize a long name: the rule I want is that the callsign is the part we ellipsize first—we middle truncate from that, preserving the custom name and dash name when present.



Yeah... sorry, but the `◊` sigil sucks. It looks terrible. We need a different character. I wish we could just go with *an em dash* (***dash***, get it?) But it doesn't read right. It looks too much like a hyphen. Let's just go with `^`, so: dash-xp:tugtool/juicy-roach^dash-steps







Now, next... Let's make general changes to the Changes sheet:
- I want to move the large `X` button in the Z5 area and move it to the top right of the shade, in a position similar to many of the other `x` buttons in the app. This button should shrink in size and the current tiny/small diff button should grow up a little bit, so that both match the size, placement, and style of right-side buttons in card headers. get what I mean here. This will lay the groundwork for coming changes to the Changes shade when we are showing the changes for a dash. For now, make this update for all cases of the Changes shade.
- The headers we have now for the different kinds of changes and for dashes are clear and legible, but fall short of the graphical quality I aspire to the rest of the app. Let's do a mini design spike via a spike card to improve how these sections look in the Changes sheet. The spike card should include a full inventory of the sections we show for all the different kinds/states we display in the Changes shade. One change for sure: *banish the possessive*; no apostrophe `s` in these headers for any topic/header.



OK. Let's consider Round 2 of dash/close-dash-join-gaps.md. To be honest, this work doesn't go far enough, not by a longshot. I have one main issue, which has this statement in the dash/close-dash-join-gaps.md as the lynchpin: "... so each `FileResolution` carries the reviewable diff..." 

Look. Tug presents an *AI workflow*. This statement implies that I, as the human developer, have some desire to reconcile diffs from divergent branches in some manual process. To be crystal clear: *nothing could be further from the truth*. Every assumption that there would be a presentation of a diff to me and an `approve/reject` interface or worklfow is a *busted idea*. Instead, there must be an *AI driven workflow*:
- Looks at the *intents, plans, base revisions, and changes*, figures out how to resolve conflicts, and just does the required fixups to the files; and in the (hopefull) rare and unusual case where my intervention is truly required, then the resolution is phrased to me in terms of *intent* and shown to me in the form of a QuestionDialog/AskUserQuestion. Does this make sense?
- The reliance on tests. Again, to be honest, I think our current app-tests are an essential part of , but there are still *many low quality tests* that spend time and tokens on wank-quality pixel measuring and checks that an API we called actually responds in some non-falsifiable fashion. This means that gating work on app-tests feels like a dubious gating requirement. But OK, maybe we build in the requirement for now, and plan for a separate round of work at a future time to improve the quality of the tests.
- We bring in the `SharedAgent` facility in the codebase to point an AI agent that is *prompted and prepared* to help with joining dashes, resolving issues that come up, escalates to human question/answer interactions when needed, and reports concisely and cogently on the results of its work.

One final note on terminology this like: "Ready to land"
🢁 You have invented this *land* term, when the term should be *join*. That's it: dashes are joined. Period. There is no *landing* process separate from *joining*. Fix this everywhere.


This deal where we cut a dash just to run an app-test *must stop*. I thought we did this whole pile of work today in commit ad22043f6. WHY are we still cutting these throwaway dashes. I *DONT WANT THIS. THIS IS A MISUSE OF DASHES*. The main usage for dashes is to *implement plans, not to run tests*. Find out why we're doing this and make it stop.





OK now. Back to the additional row we add to the session row in the Lens when a dash is running. The major problem with this change is that it breaks the consistency with the session masthead in session cards. We need to resolve this in some fashion. The masthead must also get this additional step information in some manner, but ideally, I'd like to do so *without* changing the height of the masthead. And really... honestly... changing the height of the session/Lens row is a wart too. Let's talk about what we can do to include this additional dash/step/progress information in these two areas *without* changing the heights of these elements. I honestly think there's an opportunity to create a really nice *graphical treatment* for a numbered step list that communicates progress, and I'd like to explore some options.

Also, on the Lens... We need to change the *Unbound Dashes* section which comes and goes *and promote it back* to being a full-on/always visible *Dashes* section that lists and shows all dashes in all states. The coming and going of the section is too distracting, and no other Lens section works like this. Each row in this Dashes section must be more than one line in height, so that additional information can be shown, including a reference back to the bound session, if there is one.

Also, previously in this session:
> ## One design call I’d like yours on
>
> Clipping keeps the row one line and loses the tail — in your screenshot that tail was `base overlap (2)`, which is arguably the most important fact on the row. The alternative is letting the run **wrap** to a second line: nothing is lost or cut, rows get ragged. There’s also a third answer neither fix touches: nine facts on a *collapsed* row may simply be too many, given the expanded detail carries all of them anyway. Clip is in and correct as a floor — the overlap is a bug under any of these. Say the word if you want wrap instead, or want to thin the run.

This is part of the *Dash needs to be more than one line* idea I stated above.

Make me a proposal in a graphical form in a design spike card. Try to provide resolutions to all these issues in a way that we can review and discuss. Use the /tugplug:spike skill for the part where you make the spike card.



The header in the Changes shade when showing a *dash* is a jumble of buttons and badges. This is *comically bad*. We need a mini spike to design a gallery card with better information and controls.


After we submit a dash, we can't have this *long delay* before we report to the user. Clearly, the join process takes more time that a plain old git commit. We need to give the user a progress indication that things are happening. What form should this take?

After we coming 





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

Now, next... let's look at the Dashes section in the Lens. My first question is... do we really need this separate section. I tend to think that maybe we don't. I think that we should probably improve the Sessions section and the information we give in the session card in the Cahnges shade for a dash in progress. What do you think? Should we drop this second Dash-only section? As a counterpoint to my suggestion: argue the other side and defned keeping it and how we could improve it to make it truly distinct and useful.



-----

Talk to me here. Why do *git worktrees* suck so bad? I mean... isn't git supposed to be great at merging? Why is it so colossally difficult to use git worktrees on real projects? What's the gap?



Because git is great at merging *file contents*, and a worktree is not file contents. A worktree is a **working environment**, and git explicitly declines to model 90% of what that means.

Here's the actual decomposition, in rough order of how much pain each causes:

**1. Machine-global singletons.** This is the big one and it isn't a git problem at all. Your project doesn't live only in `/src/thing` — it also lives at port 3000, in `~/Library/Application Support/Thing`, in a launchd agent, in a bundle ID, in a lockfile in `$HOME`, in a daemon that's already running. You can have N worktrees. You can have exactly one of each of those. Git can branch the source of truth; it can't branch the *runtime*. Every worktree you add is another process contending for a resource that was designed assuming there'd only ever be one checkout on the machine. You've hit this exact wall — a `tugutil` on `PATH` symlinked to main silently running old code from inside a worktree is precisely this failure: a global name resolving to a tree you're not in.

**2. Derived state is huge, expensive, and path-keyed.** `target/`, `node_modules`, `.venv`, DerivedData, IDE indexes. You can't share them (they bake absolute paths and config fingerprints), and you can't afford to duplicate them (a Rust workspace's `target/` is many GB and rebuilds cold). So a fresh worktree is either a 10-minute cold build or a subtly poisoned cache. Branch switching in a single checkout at least reuses the cache incrementally; worktrees throw that away by construction.

**3. Absolute paths leak everywhere.** `.env`, tool configs, symlinks, generated files, and the shell's own cwd. Anything that captured a path in one tree is a landmine in another — and the failure mode is almost never an error, it's *silently operating on the wrong tree*. That's the worst possible failure mode, because it looks like success.

**4. Git's own worktree UX has real warts.** `.git` is a *file* not a directory, which breaks any tool that stats for a directory. You can't check out the same branch in two trees. Submodules are a catastrophe. Hooks paths, `core.hooksPath`, prune/lock semantics, `remove` refusing on dirty state. These are annoyances rather than showstoppers, but they add friction on top of an already frictional thing.

**5. The philosophical one.** Worktrees don't reduce the merge problem — they *multiply the integration problem*. Branches are cheap partly because you work them serially: one state at a time, in your head and on disk. Worktrees are for working in parallel, which means N streams of change converging on one trunk. And git merges *text*, not *intent*. Two worktrees that each cleanly refactor the same abstraction in different directions will merge without a single conflict marker and produce broken code. Git being "great at merging" is a statement about three-way text reconciliation, which is the easy half. The hard half — did these two changes remain *true* about each other — git has never claimed to touch.

---

So what's the gap, in one line? **Git versions the repository; it doesn't version the project.** The delta between those two is everything that makes a real project real.

The only approach I've seen actually work is to stop treating a worktree as "a second copy of the repo" and start treating it as **a separate instance** — a deployment target with its own identity. Which means: nothing path-dependent may be installed globally; every binary, port, data directory, and bundle identifier is *derived at runtime from the worktree root*; absolute paths always, never relative-plus-cwd; and the instance's identity is visible in the UI so you can never be confused about which tree you're looking at. That's not a git feature and git will never ship it. It's an application-architecture property that you have to earn — which is exactly the work the dash lane in this repo represents, and why it was as much work as it was.

Worktrees don't suck. They're a thin, correct primitive that people reach for expecting it to solve a problem three layers above where it operates.




