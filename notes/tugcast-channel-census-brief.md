<!-- brief-skeleton v1 -->

# Tugcast Channel Census — Dead Feeds on a Live Wire

**Purpose:** Nine of tugcast's 39 declared feed channels carry no consumer, and seven of those still have live producers pushing frames to every connected client. The highest-cadence unconditional push in the system — the 1 Hz `STATS` aggregate — goes straight into `/dev/null` on arrival. Beyond the immediate cleanup, the broadcast-everything wire itself is the structural cause, and this brief proposes a subscription protocol to fix it.

---

## Purpose {#purpose}

The user asked: "How many channels do we have declared and how many are actually in use? I imagine that `CODE_OUTPUT` swamps everything else, but I don't know." The census question is answerable exactly from the code; the volume question is not — tugcast keeps no per-feed counters — so the volume half of this brief is grounded estimate, marked as such.

---

## Evidence {#evidence}

**[F01] 39 channels are declared, and the two tables cannot drift by inspection alone.** — `FeedId` in `tugrust/crates/tugcast-core/src/protocol.rs` declares 39 named constants over an open `u8` namespace; `tugdeck/src/protocol.ts` mirrors all 39 byte-for-byte. Compared side by side; identical today, but nothing checks it. **(verified)**

**[F02] The wire has no subscription protocol.** — Every registered stream feed and every snapshot watch is pushed to *every* connected client (`FeedRouter::add_snapshot_watches` delivers on connect and forwards thereafter; stream feeds fan out via broadcast subscribe at `ClientState::Live`). Clients filter by feed id in `connection.onFrame`. A producer with no consumer is therefore dead bytes on the wire per client, not a dead constant. **(verified)** — read out of `tugrust/crates/tugcast/src/router.rs` and `tugdeck/src/connection.ts`.

**[F03] Two channels are retired correctly.** — `GIT` (`0x20`) and `CHANGESET` (`0x23`) are reserved constants with doc comments forbidding reuse, no producer, no consumer. This is the healthy shape of an unused byte. **(verified)**

**[F04] The stats quartet is produced with nobody listening.** — `STATS` (`0x30`), `STATS_PROCESS_INFO` (`0x31`), `STATS_TOKEN_USAGE` (`0x32`), `STATS_BUILD_STATUS` (`0x33`) are all live: `feeds::stats::spawn_stats_feeds` at `tugrust/crates/tugcast/src/main.rs:1128`, receivers joined to `snapshot_watches` at `main.rs:1981`. Cadences: 5 s, 10 s, 10 s — and the `STATS` aggregate ticks at **1 s and sends unconditionally** (`feeds/stats/mod.rs`, aggregator loop), carrying a fresh `chrono::Utc::now()` timestamp so the watch channel always fires. The deck's only mentions of these four bytes are the declaration lines in `protocol.ts`; no `onFrame`, no store, no card, and nothing in `tugapp/Sources` decodes frames. That is ~28,800 discarded `STATS` frames per 8-hour client-day, ~40,000 counting all four. **(verified)** — grep of `tugdeck/src` excluding tests found zero consumers.

**[F05] The terminal triad is produced with nobody listening.** — `TERMINAL_OUTPUT` (`0x00`), `TERMINAL_INPUT` (`0x01`), `TERMINAL_RESIZE` (`0x02`). `main.rs:1652` still registers a live `TerminalFeed` — a real tmux PTY bridge, attached and reading (the `release-main` instance log for 2026-09-01 shows `tmux session exists` at boot), registered with `LagPolicy::Bootstrap` and pushed to every client. The deck's only references to the input pair are the frame builders `inputFrame()` and `resizeFrame()` in `tugdeck/src/protocol.ts` — **nothing calls either function** — and `TERMINAL_OUTPUT` has no deck reference at all. The Session card replaced the terminal; the PTY bridge underneath it was never removed. **(verified)**

**[F06] The remaining 30 channels are live end-to-end.** — Producer and consumer confirmed for each by cross-referencing `FeedId::` references in `tugrust/crates/tugcast/src` (excluding tests) against `FeedId.` references in `tugdeck/src` (excluding tests): the terminal-replacement pairs (`CODE_OUTPUT`/`CODE_INPUT`, `SHELL_OUTPUT`/`SHELL_INPUT`), the git request/response set, `FILESYSTEM`, `FILETREE`(+query), `CHANGESET_ALL`, `ACTIVITY`, `DEFAULTS`, `SESSION_SIDEBAND`, `SESSION_STATE`, `REFS_OUTPUT`/`REFS_INPUT`, `OVERVIEW`/`OVERVIEW_INPUT`, `PULSE`, `USAGE`/`USAGE_QUERY`, `JOTS`, `CONTROL`, `HEARTBEAT`. **(verified)**

**[F07] By bytes, `CODE_OUTPUT` swamps everything; by frame count it is contested.** — No per-feed counters exist anywhere in tugcast, so this is estimate, not measurement. Grounding: the Claude transcript corpus written in the last seven days is 1,404 JSONL files totalling **1.5 GB** (measured, `~/.claude/projects`), and the wire carries strictly more than the transcript because tugcode runs `--include-partial-messages` — every text delta is its own `CODE_OUTPUT` frame where the JSONL stores each message once (call it 1.5–3×). Every other feed combined is small change against that. On *frame count*, though, the fixed-cadence metronomes (`STATS` at 1 Hz, `ACTIVITY` at 4 Hz during turns, `HEARTBEAT` at 1/15 Hz) win on an idle-but-open day. What would confirm the estimate: a per-feed frame/byte counter in the router (see Open Questions). **(estimate, grounded)**

---

## Decisions {#decisions}

**[B01] Remove the stats quartet — producer, feed module, and wiring — and retire `0x30`–`0x33` as reserved constants.** The four channels have live producers, a 1 Hz unconditional tick, and zero consumers anywhere ([F04]); the `GIT`/`CHANGESET` retirement pattern ([F03]) is the established shape for the constants. This is the removal with an actual runtime cost attached, so it goes first. Revisit only if a stats card is genuinely planned — in which case the feature should re-add what it needs, not inherit this.

**[B02] Build a subscription protocol, defaulted to subscribe-everything.** Broadcasting every feed to every client is the structural cause of the dead-bytes class ([F02]); a per-feed subscription fixes the class, not just today's instances. The default is the migration path: a client that says nothing receives everything, exactly as today, so the change is wire-compatible on day one and ships with zero behavior change. Tuning then happens by opting feeds *out* (or flipping specific consumers to explicit opt-in) one at a time, each a small observable step rather than a big-bang cutover. One layering note the devise round inherits: the wire is per-connection while interest lives per-card, so the deck likely aggregates card subscriptions and the connection subscribes to the union — the deck already has the local filtering (`connection.onFrame`) to build that from.

**[B03] The terminal triad stays — producer, bridge, constants, and all.** A fuller terminal emulation is planned, going beyond the one-shot shell execution the Session card offers today, and `TERMINAL_OUTPUT`/`TERMINAL_INPUT`/`TERMINAL_RESIZE` are its wire surface. The tmux bridge is a working producer worth keeping warm rather than rebuilding later. Under [B02] the idle cost goes to zero anyway: once subscription lands, a deck with no terminal card simply doesn't subscribe `0x00`, and the triad becomes a reserved capability instead of dead bytes. The orphaned `inputFrame()`/`resizeFrame()` builders in `tugdeck/src/protocol.ts` stay too — they are the future feature's first two functions, not cruft.

**[B04] Retirement means reserved, never reused.** The stats removal follows the `GIT` precedent: the constants stay in both `protocol.rs` and `protocol.ts` with a doc comment forbidding reuse of the byte. An open `u8` namespace makes silent reuse a wire-compatibility hazard against old clients and recorded captures.

---

## Open Questions {#open-questions}

- **Where does the subscription control plane live?** The natural home is a `subscribe`/`unsubscribe` message on the existing `CONTROL` feed (`0xC0`), which already carries client→server commands — but the devise round must settle the shape: subscribe-by-feed-id list vs. bitmap, whether changes are incremental or a full replacement set, and what the server does with frames for a feed the client just unsubscribed (drop, or drain in flight).
- **How do snapshot watches interact with late subscription?** `add_snapshot_watches` delivers latest-value on connect; under [B02], subscribing a snapshot feed mid-session should presumably trigger the same latest-value delivery, or a late-subscribing card starts blank. The replay-on-subscribe cache in `tugdeck/src/connection.ts` handles this client-side for multiplexed feeds today — decide whether the server-side equivalent is needed or the client cache suffices.
- **Per-card or per-connection subscription?** [B02] sketches connection-subscribes-the-union with the deck aggregating card interest, since the wire is per-connection. Confirm that layering, and decide where the union is computed (the card registry already knows which cards are mounted).
- **Should the router grow a per-feed frame/byte counter?** It would convert [F07] from estimate to measurement, make the next census trivial, and — once [B02] lands — show what each client's subscription actually saves. Cheap to add while the router is open; the devise round should decide whether it earns its keep.
- **Should the Rust/TS feed tables be guarded against drift?** They are identical today ([F01]) by discipline alone. A test that compares the two (codegen is overkill for 39 constants) would hold the line. Small enough to ride along with [B01].

---

## Non-goals {#non-goals}

- **Reclaiming the retired bytes.** `0x20`, `0x23`, `0x30`–`0x33` stay reserved forever ([B04]). The namespace has 200+ free values; scarcity is not a reason.
- **Removing the terminal triad.** Considered in an earlier draft of this brief and rejected: a fuller terminal emulation is planned ([B03]), and [B02] makes the idle producer free anyway. Recorded here so the "seven feeds with no consumer" finding doesn't get re-run into a removal proposal.
- **Building the new terminal emulation.** [B03] keeps the wire surface warm; it does not schedule the feature. That is its own brief when its time comes.
- **Trimming `CODE_OUTPUT` volume.** It swamps by bytes ([F07]) because it carries the product. Partial-message streaming is a feature, not waste.

---

## Exit {#exit}

**A plan** — two phases matching [B01] and [B02], strictly ordered: the small deletion first, the protocol work second.

Phase 1 (stats removal): delete `tugrust/crates/tugcast/src/feeds/stats/`, the collector construction and `spawn_stats_feeds` call in `main.rs`, and the `snapshot_watches.extend`; retire the four constants in both protocol tables. Small, self-contained, `cargo nextest` plus `just app-test-changed` should cover it.

Phase 2 (subscription protocol): the control-plane message shape, the router honoring per-connection subscription sets with subscribe-everything as the unspoken default, and the deck computing the union of card interest. Ships with zero behavior change; the tuning — opting real feeds out per card — follows as its own small steps once the knob exists. The open questions above (control-plane home, snapshot replay on late subscribe, where the union is computed) are what the devise round settles first.

The two ride-along candidates (feed-table drift test, per-feed counter) are the devise round's to accept or decline; the counter's case got stronger under [B02], since it is how the knob's effect becomes visible.
