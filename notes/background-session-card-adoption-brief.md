# Card adoption — opening a card on a background session

Tug can start a session nobody is watching. It cannot yet let anybody start watching one. Every session that exists today was born with a card and lived its whole life on it, so the surface and the session were never separable — and the moment something runs in the background, the missing gesture is the same one every time: *show me that, with everything it has already done.*

This brief builds that gesture. A background session, running or settled, gains a card seated on it with its full history intact, and from that instant it is an ordinary session — the user reads the transcript, replies in the composer, redirects the work, and lands any dash the session made through the composer ⬆ like every other dash.

It is the second of two briefs. The first — [tripwire-simplification-brief.md](tripwire-simplification-brief.md) — rebuilds the tripwire engine and is the immediate consumer: a tripwire that resolves *awaiting* shows a steady yellow dot in the Lens, and this work is what makes clicking that row do the obvious thing. **That brief does not depend on this one and ships without it.** The dependency runs one way.

## Why this is not a tripwire feature

Tripwires are the first background agent, not the last. Anything that runs without a card and might later have something to say needs exactly this affordance, and a click-through built into the Tripwires section would have to be built again for the next one. So the capability is the deliverable and the tripwire row is its first caller: adoption takes a **session id**, and knows nothing about wires.

The corollary is that the Lens row's job is small — it holds a session id and dispatches an adoption request. Anything a caller needs beyond that (which dash the session made, what the wire was watching) is the caller's own presentation, not adoption's.

## What has to be true

**The history is the session's, not the card's.** A card seated on a background session must show what already happened, and the pieces exist: the session's transcript is on disk as JSONL, and Maker ▸ Reload already rebuilds a card's whole state from it — that is the true hard refresh, and it is the honest model of what adoption does at a different moment. The design question this brief settles is whether adoption reuses that path or a narrower one, and what it costs on a long transcript.

**A running session must survive being adopted.** Adoption at rest — a settled session with a finished transcript — is the easier half. Adoption of a session mid-turn is the one that decides the design: the card must attach to a live stream, receive frames from the join point onward, and reconcile them against the history it just replayed without duplicating or dropping the boundary. This is the load-bearing case, and a design that only handles the settled one has not built the capability.

**Adoption is idempotent and single-seated.** Clicking twice does not make two cards. A session already seated on a card raises that card instead of making another, and the plan says what happens when the session is seated on a card in a *different* window or project.

**The composer works, immediately.** Adoption's whole point is that the session becomes ordinary. Replying, interrupting, the responder chain, the dash's join offer — all of it must be live on the adopted card, not a read-only transcript view with a "take over" button. If a read-only surface is genuinely the cheaper first step, that is a decision to argue in the plan rather than a default to fall into.

**Nothing about the session changes because it was adopted.** No claim moves, no lineage is rewritten, no id rotates. Adoption is a surface attaching to state that already exists; if it mutates the session, that is a bug in this work.

## What to settle in the plan

- Where adoption lives: a deck-side request that tugcast answers, or a server-driven card mount. Which side owns the seat.
- Replay path: reuse the Reload path or a narrower one, and what a long transcript costs at the moment of the click.
- The live-attach boundary: how frames arriving during replay are ordered against replayed history, and what proves it in a test rather than by eye.
- Where a background session's id is discoverable at all — the Lens row has one, but the general capability wants a stated source of truth for "sessions that exist without cards."
- What the card looks like at the instant of adoption: does it open scrolled to the leading question, at the top, or wherever the transcript left off.

## Scope

**In:** adoption by session id for a background session, running or settled, with history replayed and the live stream attached; idempotent single-seating; a working composer on the adopted card; the Tripwires Lens row wired as the first caller; tests that pin the mid-turn attach boundary rather than only the settled case.

**Out:** anything about when a background session is *created* or what it is told to do — that is the caller's business, and for tripwires it is the first brief. Holding a pending `QuestionDialog` across adoption, which stays deferred until the prose leading question proves insufficient. Any general "background agent" registry beyond what naming an adoptable session actually requires.
