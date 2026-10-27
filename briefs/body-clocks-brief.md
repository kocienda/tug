<!-- brief-skeleton v1 -->

# Body clocks: sleep at five minutes, evict at two hours

**Purpose:** A card parked in another workspace comes back cold after a short absence, while the same card as an inactive tab in the shown workspace is never touched. The two body clocks are set for a machine short of memory, and on the machines Tug runs on they are the only trigger that ever fires.

---

## Purpose {#purpose}

The user's report, 2026-10-27: "the app is far too willing to offload sessions that are in a workspace that is not active. If I have three cards in this workspace, and one in another that's inactive, that's exactly the same as having four up in this workspace. Yet, if I switch back to that fourth card in that second workspace after a few minutes, it reloads from scratch. I get that we need to manage resources, but it feels like we're being a little too aggressive here in the off-loading."

The ask is to improve usability and liveness of parked cards without blowing out memory. This brief settles the two clock constants. It does not touch the dormant reveal's content lid, which the same conversation found blanks a revealed card that has nothing to catch up on; that is a separate change, named under Non-goals.

---

## Evidence {#evidence}

**[F01] The policy has two triggers, and only the clock ever fires here.** [D219] gives a hidden body (a parked workspace's card, a folded card) two ways to lose its page: the clock, and the machine's memory pressure source (`DispatchSource.makeMemoryPressureSource`, `tugapp/Sources/BodyLifecycle.swift`). This week's `release-main` log (`tugapp.log.2026-10-21` through `-27`) records 219 evictions, every one `cause=hidden`, and no `memory pressure` line at any level. The machine has 128 GB and reads 92% free with Tug's 23 page processes resident at about 10 GB. **(verified)**

**[F02] The clocks are one minute and fifteen minutes.** `DORMANT_AFTER_MS = 60_000` (`tugdeck/src/lib/body-visibility-store.ts`) and `BodyLifecycle.dormantAfter = 60_000`, `BodyLifecycle.evictAfter = 900_000` (`tugapp/Sources/BodyLifecycle.swift`). The eviction comment sets its number against "a 500-turn Session body at about 550 MB resident" and calls the clock "the quiet machine's clock" with pressure evicting sooner. **(verified)**

**[F03] The clock runs only against hidden bodies; a sibling tab is exempt.** `armEviction` and `scheduleEviction` arm only when `body.shown?.value == false`, and the dormant clock likewise. An inactive tab in a shown pane is a sibling: it keeps its page, keeps its subscription, paints at opacity 0, and is taken only by critical pressure. So the user's premise holds: three cards here plus one parked elsewhere cost the same memory as four here, and the parked one is the only one on a clock. **(verified)**

**[F04] The reported card followed the clock exactly.** Card `3fe74ac2…` today: hidden 21:36:50, declared dormant 21:37:50, evicted 21:51:50 with six workspace-mates in the same second, its cover dropped as `aged` at 22:06:50, revived cold at 22:39:26 (`whole_ms=879.9`, `start=cold`) with no cover under it. In the hour before the eviction the same card went dormant and was revealed three times, at 6 and 8 minute gaps. **(verified)**

**[F05] What the two reveals cost.** This week: 473 cold arrivals at a mean of 824 ms, 195 warm arrivals (bound to the spare page) at a mean of 180 ms. A dormant reveal is cheaper but not free: the content box is lidded with pane background from the sleep until the catch-up replay's bracket closes, so a revealed card goes empty and then fills, even when the replay carries nothing. Today's `tugcast.log` shows 46 `request_replay` dispatches with `reload_reason="catch-up"`. **(verified)**

**[F06] A dormant body costs memory and nothing else.** Dormant, the page's session subscription is empty so tugcast sends it nothing, its ingest worker idles, its loops are stilled through the motion switch, and WebKit throttles the hidden view (`body-dormancy.ts`, [B05] in `router.rs`). The only resource a dormant page holds is its process's resident memory, which is the one resource the pressure source watches. **(verified)**

**[F07] Nothing but the constants and their prose names the numbers.** The app-tests shorten both clocks through the harness seam `__tug.bodyDelays` (`tests/app-test/body-grounding/`, 600 to 800 ms), so no app-test depends on the production values. One unit test pins the dormant constant: `tugdeck/src/lib/__tests__/body-visibility-store.test.ts:179` asserts `DORMANT_AFTER_MS` is `60_000`. The prose that names them is the two constants' doc comments, [D219], and `tuglaws/card-architecture.md` lines 42 and 43. The cover's aging already keys off `evictAfterMs` (`covers.keep(… agesAfterMs: self.evictAfterMs)`), so it follows the eviction clock without a change of its own. **(verified)**

---

## Decisions {#decisions}

**[B01] The eviction clock moves from fifteen minutes to two hours.** The clock exists for the quiet machine, where pressure never speaks, and on that machine it is throwing away pages nobody needs reclaimed: 219 cold rebuilds this week against zero pressure events. Two hours is "left for the afternoon" rather than "glanced away during a build". Memory pressure stays the real guard, unchanged: on a machine that is short, a warning still takes hidden bodies oldest-first and critical still takes every non-visible body. The number is a constant, as [D219] requires, not a setting. Revisit if a quiet machine is ever seen to accumulate parked pages past what its own pressure source would catch.

**[B02] The dormant delay moves from one minute to five, on both sides.** Dormancy is nearly free ([F06]), so the delay buys only the avoidance of a catch-up and its lid on reveal. One minute is shorter than the gaps the user actually bounces between workspaces at ([F04]: 6 and 8 minutes), and every one of those reveals paid a blank. Five minutes covers a bounce; a workspace left longer than that sleeps as before. The page's `DORMANT_AFTER_MS` and the host's `BodyLifecycle.dormantAfter` are the same number by contract (the host's comment says so) and move together.

**[B03] The unit pin moves with the constant, and the prose moves with both.** The `body-visibility-store` test's assertion of `60_000` is a pin on the value, not on a guarantee, so it is re-pointed to the new value rather than deleted. The two doc comments, [D219], and `card-architecture.md` say the new numbers and the reasoning in [B01]: the clock is the quiet machine's backstop, pressure is the guard. A second decision is appended to [D219] rather than editing its text, since the tiers and triggers it records are unchanged and only the two numbers move.

**[B04] No third trigger, and no change to what the triggers do.** The shape of [D219] stands: two triggers, no count, no byte budget, no preference. The pressure path, the sibling exemption, the cover budget and the lane are untouched.

---

## Non-goals {#non-goals}

- **The dormant reveal's content lid.** The conversation found that a revealed dormant card is lidded until its catch-up bracket closes even when the session was idle the whole time, so the card blanks to show what it already had. That is a real defect and the larger liveness win, and it is explicitly left for its own brief: it changes the reveal's behaviour, where this brief changes two numbers.
- **A byte or count budget as a third trigger.** [D219] ruled out a count deliberately, and the pressure source already is the memory budget, set by the OS. A host-read free-memory fraction would be a second, worse judge of the same thing.
- **A preference for either clock.** The Layout card's Rest and Release rows were removed 2026-10-22 and [D219] says the delays are constants. Nothing here reopens that.
- **Reading page process memory from the host.** A WKWebView's process id is not public API, so a resident-footprint gate on the clock is not buildable without private calls.

---

## Exit {#exit}

An arc. The shape is small and the order is fixed by the test pin:

- Move `BodyLifecycle.evictAfter` to 7,200,000 ms and `BodyLifecycle.dormantAfter` to 300,000 ms, rewriting their doc comments to say the quiet machine's backstop and pressure's role ([B01], [B02]).
- Move `DORMANT_AFTER_MS` to 300,000 and re-point the pin in `body-visibility-store.test.ts` ([B02], [B03]).
- Update the dormant and evicted tier lines in `tuglaws/card-architecture.md` and append a decision beside [D219] recording the two new numbers and why ([B03]).
- Verdict: the `body-visibility-store` unit test, and the body-grounding rows that exercise the clocks through the harness seam (`row-35-dormancy`, `row-39-evict-after`), which should be unaffected because they set their own delays ([F07]).
