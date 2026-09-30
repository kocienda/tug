OK. I want a comprehensive look at the graphics and animation work we've done lately. I feel like we're still missing any sort of grand-unified notion of how to package and deliver expellent graphics and animation in the app across all the major behaviors and features that are important to me, which include:
- Appearance and disapperance of new cards, including any juddering or hopping, as described in [session-body-first-frame-brief.md](</Users/kocienda/Mounts/u/src/tug/briefs/session-body-first-frame-brief.md>)
- Layout impostion in slots, especially when a column is in split mode. This means sliding cards and resizing their heights appropriately.
- The fold/unfold animation for cards
- Sliding cards into view from offscreen when a deck is in flow mode and there are more cards on the deck than can be shown on one screen. This *often* drops *many frames* now, while working perfectly smoothly other times.
- Going to a slot with the *Go* menu options.
- Moving cards into and out of the bullseye position.
- Hiding/showing sidebar cards (and the associated content card movements that follow on from this)
- Resizing sidebar cards to fit.
- Smooth pulsing-dot, wave, and caret-blink animations that *never* drop a frame.
- Extraneaous/useless animations which have crept into the mix, e.g. Why is there an *animation* when I activate an deactivate a card—I never asked for that, and this motion is of low value when it comes to telling any kind of story about what’s happening. Remove this. Let’s spend those cycles elsewhere.
- Smooth switching between workspaces that never pauses, delays, or drops frames.

Basically, my ask here is for an *system infrastructure* that delivers on all these aspects—and more, in that the development of app is far from finished. I want a judder-free foundation for excellent animations, silky smooth transitions, and rock-solid consistency across all these interactions and behaviors.

It feels like we're still in the age of one-off fixes for many, if not most, of these graphical features, and I want a full 360° audit for how we might draw all the strings and threads together into something *much much* better.

Let's discuss how to get there. I want *unifying concepts* we can build on. Dig in. Make me a sketch we can discuss.



Five concepts I would build on. They are ordered by leverage.

1. **Motion before React, as the rule for every gesture rather than the fold’s fix.** The imposer is already a pure function of store state: pane `left` is a calc over the flow offset, heights come from shares and tiers. So the *target* geometry is computable in the store subscriber, where `arm` already measures First rects, before React renders a single pane. FLIP becomes “First measured, Last computed”, the tween launches from the subscriber, and React commits under a frame that is already moving. This is L22 generalized and it is the single change that addresses the flow slide, the fold, the new card, and activation together, because it takes the commit out of the first frame’s budget instead of shaving it. The open question is which terms cannot be computed without the DOM, and the answer decides how much of the Last pass survives as reconciliation.

2. **The Beat as the only motion primitive.** One object above `animate()` in `tug-animator.ts` that owns five things: the start pose written to the DOM by the frame before any clock exists, a start tied to a painted frame and never to a task, transform and opacity on layers that already stand, one hand-back of the end pose, and its own frame record. Arrive, depart, move, room, fold, body-in, rail slide, zone-drop landing, jots well, and the Z2 occupant all become beats with a recipe name. A lint then refuses any `animate(` or entrance `@keyframes` in product code that is not a beat or a registered loop. That is the “Tug animation API” [D3] promised and deferred.

3. **Nothing is created or destroyed inside a gesture.** Already law for pane layers. Extend it to the departure ghost, which is a new fixed layer planted at frame one, and to the rail shadow strips. The doctrine already names the right end state: a `departing` mark on the real frame, excluded from the solver, symmetric with `arriving`. Same for the session body: it already mounts hidden and reveals, so its fade should be the arrive beat, not a second engine.

4. **One hold, one quiet.** Today there are five gates: arrival quiet, the body’s proposed quiet, the settle’s notification hold, the workspace epoch, and the fold end event. Make it one: a beat opens a hold on the stores when it plans, a surface declares its quiet sources, and the beat’s landing is the only release. The 250 ms arrival bound and the settle’s watchdog become the same bound.

5. **Height crosses by translation and occlusion, never by a height keyframe.** The one standing D9 violation is the real `height` term in split, join, fold and resize-to-fit, paid on the main thread every frame, with the still-crossing hold as its bandage and a layout hitch at release. The flow-band brief already showed the shape of the answer: stop cutting, start occluding. A folding card’s content is held at the old height, its bottom chrome edge and the opaque neighbor below translate up over it, and the card’s box snaps to its final height in the commit nobody sees. Corners and edges become small standing pieces. This is a candidate to bench, not a decision, but it is the only route to a settle window that is compositor-only in fact rather than in name.

Two cross-cutting rules ride along. **One instrument, one bar, every beat:** the settle record, the gesture probe, the switch-frames record and the body probe collapse into one per-beat row with a fixed bar. Lead at most one frame from the gesture, no gap over one frame, zero off-curve ticks, no geometry change after the land, tick count above the suspension floor. It is on by default in the product, so “sometimes drops frames” becomes a named row in `tugtool deck motion`. And **remove, don’t rebuild, the recede fade.** What you see on activate and deactivate is a 300 ms opacity fade of the dim over every other card, started after the settle lands, owned by `tugdeck/src/lib/pane-recede.ts`. Deleting it reverses the pipeline brief’s decision to keep it, and that reversal should be written down.