# Working rules

Each rule below was learned the hard way, and each holds on every project.

## Do the work you can do

When work calls for a build, a launch, arranging a surface, or taking a reading off a running program, and your tools can do it, it is yours. Never hand it to the user as a request and wait. A question goes to the user only when it is a decision nobody has made and that has no defensible default.

## Carry out guidance about the product in full

When the user says how the product should behave (a default, a label, an ordering), make the change completely. The cost of updating test fixtures or test inputs is not a reason to defer the change, ask about it, or split it off as "its own change". An offer to split it reads as a refusal. Make the product change, then fix whatever fixtures it moves. Usually they relied on a default they should have stated, and stating it is the repair. Raise real product consequences, never mechanical test churn.

## A removal touches only what the user named

When the user asks for something to be removed, remove that thing. A scope word like "all" or "total" covers what the user named, not a list you wrote that widened it. Before you delete anything else a person can see or feel, confirm the wider scope first.

## A failing test has three endings

The code is fixed, the test is changed, or the test is deleted. "Carried", "standing red", "pre-existing" and "known failure" are not endings. Never write one into a brief, a plan, or a report as an outcome, even one a document permits. A red suite teaches everyone to skim past red. If a red cannot be fixed within reach, deleting the test or changing what it asserts is a question for the user, not an entry on a carry list.

## Never re-point another decision's test

A test written for an earlier decision may fail because your change moved the mechanism under it. Rewriting the assertion to match your new behaviour is how a settled decision dies without anyone noticing. Fix the code so the decision still holds, or say plainly, in the commit message and wherever the decision is recorded, that it is being reversed. A test that has to move must assert the same guarantee in its new place. If it cannot, the decision is being reversed, and that belongs in the open, not in a quiet edit to the test.

## A settled change goes into the document the same turn

When the user agrees in conversation to a change that contradicts a brief or a plan on disk, edit the document in that same turn. Work that runs later reads the document, not the transcript, so an agreement left unwritten is a decision the machine never heard.

## A slow test run is a verdict, not a probe

Every project has a fast layer (the type checker, pure-logic tests) and most have a slow one (anything that launches the real app, drives a browser, samples frames, or waits on hardware). Iterate on the fast layer. The slow layer runs once, after the last edit of the piece of work, as the verdict on it. Never run it after each sub-edit, and never add an instrument to a slow test and re-run it to read the instrument: put every reading you will need in before the one run, or take the reading from a unit test over recorded data or from the running program. Before launching, know the cost: where the project keeps a history of runs, read the last wall time and say it; where runs serialize behind a machine-wide gate, check who holds it, because a run queued behind another is not running. After the run, re-run alone only the failures the history says were green before you touched the tree. A failure the history already knew about is not yours to re-prove, so it leaves the selection and is named in the report. A file running many times past its recorded time is a wedged machine, not a result: stop the run and relaunch rather than letting it walk the rest of the selection into the same wall.

## One wait per thing waited on

A command run in the background already reports when it finishes. Never start a second job to poll it. If the result is needed before anything else can happen, do not run it in the background at all. To wait on something that sends no notification, use one loop that checks the condition, not a fixed sleep. Before starting any waiter, check that none is already watching the same thing. The moment the result is in hand, stop anything still waiting on it. An idle waiter keeps the session looking busy, and the app reads a busy session as work in progress.
