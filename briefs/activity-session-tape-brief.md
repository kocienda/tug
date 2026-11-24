# Activity Session Tape

**Purpose:** Each page draws a session's activity from its own private record, which starts empty when the page starts listening. Two surfaces showing one session can disagree, and a page that opens or wakes mid-turn shows a past that never happened.

---

## Purpose {#purpose}

The ask, 2026-11-24, was to "improve the robustness and quality/coverage of the sparkline". Coverage is the two briefs before this one. Robustness is two things: that a listing page hears activity at all (`activity-watch-scope-brief.md`), and that what any page draws is the session's real recent past. This brief is the second.

It is the last of four briefs from one sketch and the largest. It builds on the watch scope and is easier once tugcast is already a producer of activity (`activity-session-accounting-brief.md`, `activity-machine-channel-brief.md`).

---

## Evidence {#evidence}

**[F01] Every page keeps its own meters.** The shell and every body page each call `attachSessionActivityStore` on their own connection (`tugdeck/src/main.tsx:856`, `tugdeck/src/body/body-main.ts:1102`). A store's meters hold only the frames that connection has delivered since the page loaded. **(verified)**

**[F02] A bin is filed by when its frame was received.** The store stamps each frame with `Date.now()` on arrival (`tugdeck/src/lib/session-activity-store.ts:248`); the comment says tugcode stamps no time of its own. A frame delayed in transit lands in a later bin, and frames that arrive together pile into one. **(verified)**

**[F03] A page that has not been listening has no past.** A dormant body is refused every session-scoped frame (`admits_while_dormant` in `tugrust/crates/tugcast/src/router.rs`), and a new page starts with empty meters. The instrument draws 15 seconds of window (`ACTIVITY_WINDOW_BINS` covers 20), so a page revealed mid-turn draws up to 15 seconds of flat line beside live data. This follows from the code; it was not observed on screen.

**[F04] A lagged frame is dropped with a warning and nothing fills the hole.** ACTIVITY is registered with `LagPolicy::Warn` (`tugrust/crates/tugcast/src/boot/feeds.rs:754`). There is no replay buffer for it and nothing on the deck knows a bin went missing. **(verified from the registration; no drop was observed)**

**[F05] tugcast has nowhere that holds a session's recent activity.** The merger diverts tugcode's `activity_delta` frames onto the feed as they pass (`tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs` about line 4598) and the resource sampler publishes its own; neither keeps what it sent. **(verified)**

---

## Decisions {#decisions}

**[B01] tugcast holds one tape per session: the last 80 bins of each rate channel.** That is the 20 seconds the deck's meters hold today. It is in memory only; the tape is an instrument reading, and a tugcast restart starting it empty is correct.

**[B02] Every producer writes into the tape, and the tape is what publishes.** tugcode's diverted frames, the report beat and the `machine` sampler all record into the session's tape, which sums them into the current bin and publishes one frame per session per bin. Producers stop publishing ACTIVITY themselves.

**[B03] Every frame carries the index of the bin it describes.** The index is tugcast's clock divided by the bin width. The deck files a bin where its stamp says, so transit delay moves nothing.

**[B04] A page that starts listening to a session is sent that session's window whole.** Starting to listen means a connect, a watch or bound scope that newly admits the session, a wake from dormancy, or a reconnect. The window is one frame holding every channel's bins with their base index.

**[B05] The deck's store is a replica of the tape.** A window replaces the session's meters outright; a bin frame sets its bin. The store's public surface, `series`, `compositeSeries`, `dominant`, `subscribeActivity`, is unchanged, so the instrument and its callers do not move.

**[B06] The two machines' clocks never meet.** The deck does not compare tugcast's bin index with its own `Date.now()`. It places the newest index it has been told about at its own present and draws backward from there. tugcast and the deck are on one machine today, and the instrument already draws two bins behind the clock, but the rule holds if they are ever apart.

**[B07] Gauges are left as they are.** `cpu`, `memory` and `disk` publish on change and hold, and the Activity card reads them. A page that starts listening is sent each gauge's current level with the window, so a gauge row does not sit at zero until the level next moves.

---

## Calls you have not seen {#unseen-calls}

- The window frame and the bin frame are two shapes on the one ACTIVITY feed, told apart by a field, rather than a second feed. Say so if a snapshot feed of its own is cleaner.
- A session's tape is dropped when its tugcode process ends and its last bin has aged out of the window.
- The tape lives in a new `tugrust/crates/tugcast/src/feeds/activity/tape.rs`.

---

## Open Questions {#open-questions}

- How a window is addressed to one connection. The router has an addressed lane (`AddressedFrame` in `tugrust/crates/tugcast/src/pages.rs`) and the scope change is seen where the `sessions` message is handled. Whether the window is sent from there, or the tape is asked for it by the forwarder, is a reading of the router the arc has to do before it writes anything.
- Whether a bin frame should be published for an empty bin that follows a non-empty one. Today no frame means zero and the deck's meter zero-fills as its own clock advances. Under [B06] the deck's present moves only when told, so either tugcast publishes a closing zero, or the deck keeps advancing by its own clock between frames. The second is closer to what the instrument does now.

---

## Non-goals {#non-goals}

- **Persisting the tape.** It is twenty seconds of an instrument's reading.
- **A longer history.** The window is what the screen shows. A minute-scale or session-scale view of activity is a different surface with different bins.
- **Replacing the instrument.** `SparklineInstrument` and `TugSparkline` are not touched; they are handed the same bins from the same store methods.
- **Showing waiting as activity.** Settled 2026-11-24.

---

## Exit {#exit}

An arc, after the watch-scope arc has landed. A shape for its first steps:

1. The tape as a pure structure in tugcast, record, advance and window, tested as `RateMeter` is.
2. The producers write into it and it publishes stamped bin frames; the deck files bins by stamp. At this point every surface agrees while listening.
3. The window on start-to-listen, after the router reading of the first open question, and the store's replace-outright path.
4. One app-test: a card revealed mid-turn draws a tape that is not at rest in its first reading.
