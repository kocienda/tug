# One tap, one digest: consolidating what a session says it is doing

**Purpose:** Tug generates three separate human-readable accounts of what a session is doing — the masthead's pulse beat, the standing synopsis sentence, and the Observer's Overview posts — from three taps on the same wire, in two languages, with two models. The masthead beat is the weakest of the three and the one looked at most. This brief records why, and settles the consolidation.

---

## Purpose {#purpose}

The user's report, verbatim:

> To be honest, when a session turn is active/underway, the two-part pulse beat that we show in the masthead *isn't as good* as what we show in the Observer. The Observer is livelier and more on point. Why is this? Given this fact, it seems silly that we should have *three different streams* of *what a session is doing*. […] I think this code has maybe gotten a little shaggy, and would benefit from a consolidation of the features.

Three things are wanted: an answer to *why*, an audit of the code, and a consolidated shape. The sketch that settled the shape is in the conversation; the three calls the user made on it are recorded under Decisions.

---

## Evidence {#evidence}

**[F01] The masthead beat is machine-extracted, never written** — `tugcode/src/pulse/voice.ts` quotes the assistant's last settled sentence verbatim (`extractDisplay`) or synthesizes a tool beat (`narrateTool`, `synthesizeToolLine`: "Editing foo.ts — 37 lines"). The two-part form pins the last monologue sentence that clears `INTENT_MIN_CHARS = 24` and `INTENT_MIN_WORDS = 4` as the "intent". Claude Code's interstitial narration is mostly of the "Let me check the reducer" kind, so the pinned intent is thin and the beat under it is a tool name and a path. **(verified, read from the code)**

**[F02] The beat never sees the user's prompt or a tool's result** — `feeds/pulse.rs` taps only `CODE_OUTPUT` through `PULSE_FORWARD_ALLOWLIST`; the submission wire is not forwarded. The voice reads `tool_result` only to end a permission wait (`endWait`). The Observer, by contrast, buffers `user_message` submissions (`handle_submission_frame`) and every `tool_result` body. That difference in evidence is most of the difference in voice. **(verified)**

**[F03] The Observer is fed raw wire JSON** — `FrameBuffer::push` in `observer_wake.rs` stores `String::from_utf8_lossy(&frame.payload)` verbatim, up to `DEFAULT_BUFFER_MAX_FRAMES = 256` frames and `BUFFER_MAX_BYTES = 256 KiB` per wake, and `compose_observer_input` hands that block to Sonnet under `SESSION ACTIVITY SINCE THEN:` together with the facts section and its last five posts. This is why the Observer is on point, and why a post is the most expensive and slowest thing in the subsystem: `OBSERVER_POST_TIMEOUT` is 120 s and `OBSERVER_POST_SLOW` is 60 s. **(verified)**

**[F04] The Observer is lively in voice, not in time** — its wakes are turn-end, a sitrep timer at `DEFAULT_SITREP_SECS = 90`, session-end, and a token threshold that is off by default. The beat updates on a 1 s throttle (`VOICE_THROTTLE_MS`). The synopsis is asked at most once per `SYNOPSIS_MIN_INTERVAL = 60 s`, with one settle refresh 30 s after a turn ends. **(verified)**

**[F05] Three taps on one wire, two allowlists, two mute sets, two digesters in two languages** — `pulse.rs` carries `PULSE_FORWARD_ALLOWLIST` and a replay mute set in `forwardable_session`; `observer_wake.rs` carries `OBSERVER_FORWARD_ALLOWLIST` and its own `forwardable_session`, whose docblock says it "mirrors `feeds::pulse::forwardable_session`"; `session_synopsis.rs` imports the pulse's. The same frames are then rendered into lines twice: `voice.ts` writes "Reading foo.ts" while `session_synopsis.rs` writes `Read(foo.ts)`, `$ cmd`, and `said: …`. Two spellings of one event, one in TypeScript and one in Rust. **(verified)**

**[F06] Sizes** — pulse (daemon, bridge, deck store, line renderers, `TugPulse`, `PulseBeatText`, activity line) about 3,300 lines; synopsis (`session_synopsis.rs` plus its deck store) about 5,000; Observer (`observer.rs`, `observer_wake.rs`, `overview_agent.rs`, `overview_replay.rs`, `facts_library.rs`) about 6,700. Three Rust test corpora and one TypeScript corpus of 982 lines cover the same tap-and-digest step. **(verified, `wc -l`)**

**[F07] The pulse carries the residue of retired designs** — `TugPulse` still has a headline level, an `inline` layout for the Z2 strip [D132] retired, and four typographic presets. Two modules compose rest sentences: `pulse-line/resting-line.ts` ("Completed at …. Ready.") and `session-activity-line.ts` ("7 turns, 48.2 KB. Last updated …. Ready."); each recognizes the `Done` marker on its own. The wall register, the intent pinning, and the grouped history popover in `session-masthead.tsx` each exist to make an extracted line read like a thought. **(verified)**

**[F08] The synopsis is the opposite failure from the Observer** — it receives an over-curated digest (`compose_synopsis_digest`: the newest ask, prior asks, the opening ask, eight activity lines, the previous sentence) and then `ground_synopsis` refuses any line whose words are not in that digest. The instructions are extractive by design to keep the refusal rate down. The result is a stable line that is rarely wrong and rarely says much. **(verified)**

**[F09] Doctrine is stale or missing** — [D103] describes `pulse/ticker.ts` and a `SessionPulseStrip` beneath Z2; neither file exists (`tugcode/src/pulse/` holds `main-pulse.ts`, `types.ts`, `voice.ts`). No design decision names the Overview or the Observer at all. The `[P09]` laws cited by `voice.ts`, `session-masthead.tsx`, and `session-identity-row.tsx` live only in code comments. **(verified, `rg`)**

**[F10] The premise that removed the model from the pulse no longer holds everywhere** — [D103] records that the model commentator was retired across nine prompt versions because it restated the transcript the reader was already following. That was true of a strip under an open transcript. A minimized card ([D185]) and the Cards rows show no transcript beside the line, so the line is the only account of the session the reader has. **(inference from [D103] and [D185]; the user's report is the confirmation)**

**[F11] Model plumbing already exists for one ask returning two things** — the Observer's envelope is strict JSON parsed by `parse_envelope`, with `{"post": null}` as a first-class answer. The `synopsis` job is a `JobSpec` on the Haiku pool's sentence lane; the Observer's is a `JobSpec` on the Sonnet pool (`OVERVIEW_AGENT_JOBS`). Adding a field to the envelope and deleting a `JobSpec` are both shapes `shared_agent.rs` anticipates. **(verified)**

**[F12] The pulse's footprint, inventoried** — every artifact that exists because of the daemon, the feed, or the retired strip, found by name and by reference (`find -iname '*pulse*'`, `rg tugpulse`, `rg -i pulse` over the deck, the crates, the scripts, and the tests). **(verified)**

*Daemon and build.* `tugcode/src/pulse/` (`main-pulse.ts`, `types.ts`, `voice.ts`, `__tests__/`), `tugcode/src/__tests__/pulse-voice-labels.test.ts`; the two `bun build --compile … tugpulse` lines in `Justfile` and the `tugpulse` entry in its binary list; `tugrust/scripts/build-release-inputs.sh` and `build-app.sh` (compile and copy), `sign-bundle.sh` step 3b; the two `tugpulse` copy paths in `tugapp/Tug.xcodeproj/project.pbxproj`; `resolve_tugpulse_path` and the `TugpulseSpawner` wiring in `tugcast/src/main.rs`; the `tugpulse` mention in `tugcore/src/quiesce.rs`'s service list and the `tugpulse --seed` sample in `tugcore/src/janitor.rs`.

*Bridge, ledger, and wire.* `tugcast/src/feeds/pulse.rs` whole (bridge, spawner, allowlist, mute set, `--seed` reseed, `PULSE_LEDGER_CAP`, `PULSE_TAIL_LEN`, the enabled knob); the `pulse_lines` table, `record_pulse_line`, `list_pulse_lines_per_scope`, and the migrations `migrate_pulse_lines_add_intent` and `migrate_drop_pulse_overviews` in `session_ledger.rs`; the `list_pulse_lines` CONTROL verb and `do_list_pulse_lines` in `agent_supervisor.rs`; `FeedId::PULSE` (0x80) and its name in `tugcast-core/src/protocol.rs` and the drop-counter line in `router.rs`; the `scribe.rs` docblock that names `TugpulseSpawner` as its sibling. Deck side: `protocol.ts`'s `PULSE` id, `PulseLineWireRow`, `ListPulseLinesOk`, `encodeListPulseLines`, `PulseFramePayload`, `parsePulseFrame`; the `list_pulse_lines_ok` action in `action-dispatch.ts`; `attachPulseStore` in `main.tsx`; `publishPulseFrame` and `_ingestPulseFrameForTest` on `test-surface.ts` (surface version 1.17.0's addition); `code-session-store.ts`'s `clearScope` call on submit.

*Deck stores and renderers.* `lib/pulse-store.ts` and its test; `lib/pulse-line/` (`render-pulse-line.ts`, `beat-file-target.ts`, `resting-line.ts`, their tests); `lib/session-activity-line.ts`; `components/tugways/tug-pulse.tsx` and `.css` (the headline level, the `inline` layout, the `machine`/`condensed-*` preset ladder, `TUG_PULSE_PRESETS`, `TUG_PULSE_DEFAULT_PRESET`, `useMiddleTruncation`); `pulse-beat-text.tsx` and `.css`; `cards/pulse-card.tsx` and `.css` (the sparkline small-multiples popover, which is an activity-meter surface and only *named* for the pulse); the `preset` prop on `tug-session-row.tsx`; `session-masthead.tsx`'s `SessionPulseHistory`, `SessionPulseHistoryIntent`, `SessionPulseHistoryBeat`, `composeLineCopy`, `PULSE_HISTORY_COUNT`; the `.session-masthead-pulse-text`, `.session-pulse-history-*`, `.tug-pulse` knob overrides, and the minimized-tier `.tug-pulse-activity` clamp in `session-masthead.css`; the `.tug-pulse` override in `masthead-frame.css`; the `.tug-pulse-trailing` selector note in `session-activity-sparkline.tsx`; the "compact PULSE sparkline" tint comment in every theme file; `jots-card.tsx`'s two `renderPulseLine` calls, which borrow the one-line markdown renderer for a jot's incipit.

*Spike and fixtures.* `spikes/spike-pulse-display.tsx` and `.css` plus its `spike-registry.tsx` entry, the design surface for the presets and the four retired row fits; `tugcast/tests/fixtures/stream-json-catalog/v2.1.173-pulse-spike/` (the Haiku commentator capture, its probe, and its README), which pins constants of a daemon that no longer has a model in it.

*Tests and gates.* `lib/__tests__/pulse-ink-gate.test.ts`; app tests `at0498-masthead-pulse-file-open` (the feed end to end) and the `publishPulseFrame` uses in `at0140`, `at0157`, `at0280`, `at0343`, `at0551`; the four `#[test]`s in `pulse.rs`; the 982 lines under `tugcode/src/pulse/__tests__/`.

*Doctrine and prose.* [D103] whole; the pulse passages of [D132]; the `[P09]` citations in `voice.ts`, `voice.test.ts`, `tug-pane.tsx`, `session-masthead.tsx`, `session-identity-row.tsx` and `.css`, and `at0551`; the "PULSE dwell queue" comment in `tug-pane.tsx`; the "pulse strip" comments in `tugcode/src/session.ts` and `types.ts` that explain why `tool_input_progress` fragments exist.

---

## Decisions {#decisions}

**[B01] One tap in Rust, one digest per session, and every reader reads it.** A single `CODE_OUTPUT` plus submission tap, one allowlist, one replay mute set, and one frame-to-line digester replace the three of [F05]. The digester keeps a session-keyed rolling deque of lines: the user's ask, the assistant's settled sentences, tool calls with their target, a clipped result line per tool, shell commands, turn boundaries, and the notice beats the voice narrates today (compaction, retries, fallbacks, background jobs, permission waits). The digest is the one spelling of every event; anything that used to be spelled twice is spelled here or not at all.

**[B02] The instant beat is the newest digest line, and the `tugpulse` daemon is retired.** The beat stays deterministic and sub-second, because a model cannot keep a line that moves every second and [D103] already walked that road. It moves from TypeScript to Rust: `voice.ts`'s extraction and narration rules are ported into the digester, the `PULSE` feed carries the digest's newest line per scope with the same `text`/`intent` shape the deck already folds, and the daemon, its spawn contract, and its stdin/stdout bridge go. **Losing the TypeScript-typed parse of `OutboundMessage` is accepted** — the user's call. `payload_inspector.rs` already parses these frames in Rust; the drift guard [D103] valued is replaced by a fixture test that feeds a recorded frame stream through the digester and pins the lines it produces.

**[B03] The Observer reads the digest, not raw frames.** `FrameBuffer` holds digest lines instead of payload JSON [F03]. The digest keeps a clipped result line per tool so the Observer does not lose what came back. Ref validation runs against the rendered digest and the facts section as it does today, so a path or sha the digest never spelled still cannot be linked. This cuts a wake's input by an order of magnitude and makes the Observer's evidence the same lines the beat shows.

**[B04] The synopsis reads the digest as its activity section and nothing else changes in step one.** The first step is a consolidation of producers, not of readings: every surface says what it said before. That is what makes the step reviewable against the running app.

**[B05] Second step: one Sonnet ask returns both the post and the standing sentence, and the synopsis job is deleted.** The Observer's envelope grows a `synopsis` field beside `post`; Rust writes it to `sessions.synopsis` through the existing push, and the `synopsis` `JobSpec`, `session_synopsis.rs`, its tenant switch, and its deck store go. The Observer's instructions absorb the synopsis's register rules (start with a verb, sentence case, about 65 characters, name the work and its object) as the contract for that field. **Haiku is off this work entirely** — the user's call; the quality gain is worth the cost.

**[B06] The Observer's cadence is 60 seconds, and Sonnet writes the masthead's upper line.** `DEFAULT_SITREP_SECS` moves from 90 to 60, matching the synopsis cadence it replaces. During a turn the masthead's intent line shows the session's newest Observer post; the beat under it is the digest's newest line. At rest the line is what it is today. The `intent` pinning in the voice [F01] and the wall register's "completed with intent" rest form are retired with it, because a written sentence is standing where an extracted one stood.

**[B07] The doctrine is rewritten, not amended.** [D103] is superseded by a decision describing the tap, the digest, and its three readings; the Overview gets its first decision entry; the `[P09]` laws the code cites are either written into `tuglaws/` or the citations are removed. A subsystem whose only doctrine names files that do not exist has no doctrine.

**[B08] Pulse residue goes with the daemon.** `TugPulse`'s headline level, `inline` layout, and preset ladder; one of the two rest-sentence modules; and the duplicate `Done`-marker recognition [F07] are removed rather than carried over. What survives is the two-line wall register on a minimized card and the grouped history popover, both of which now group by Observer post rather than by pinned intent.

**[B09] The cleanup is comprehensive: every item in [F12] is deleted, renamed, or rewritten, and the word "pulse" leaves the codebase except where it names the sparkline.** A consolidation that leaves the old feature's name on a store, a feed id, a ledger table, a build step, and a spike is a rename waiting to be done badly later. So the arc treats [F12] as a checklist and closes every line of it, with these calls:

- *Delete outright:* `tugcode/src/pulse/` and its tests, `pulse-voice-labels.test.ts`, `feeds/pulse.rs`, `spike-pulse-display.tsx`/`.css` and its registry entry, the `v2.1.173-pulse-spike` fixture directory, `pulse-ink-gate.test.ts`, `resting-line.ts` (its stamp formatter moves beside `session-activity-line.ts`'s), `TugPulse`'s headline level, `inline` layout, preset ladder, and the `preset` prop on `tug-session-row.tsx`, every `tugpulse` build, copy, and sign step, `resolve_tugpulse_path` and `TugpulseSpawner`, the `--seed` contract, and the `tugpulse` mentions in `quiesce.rs` and `janitor.rs`.
- *Retire the ledger table and the CONTROL pair:* `pulse_lines` is dropped by a registered migration (the `migrate_drop_pulse_overviews` precedent), `record_pulse_line`, `list_pulse_lines_per_scope`, `list_pulse_lines`, `do_list_pulse_lines`, `encodeListPulseLines`, `ListPulseLinesOk`, `PulseLineWireRow`, and the `list_pulse_lines_ok` action go with it. The beat is a live line; a reconnecting deck asks the digester for its per-session tail through one new CONTROL read named for the digest, and nothing is persisted for it.
- *Rename what survives:* the feed id keeps its byte and takes the digest's name; `pulse-store.ts` becomes the digest's store; `render-pulse-line.ts` and `beat-file-target.ts` are named for what they render, a one-line markdown beat, and `jots-card.tsx` imports the new name; `pulse-beat-text.tsx`, `pulse-card.tsx`, and the `.session-pulse-history-*`, `.session-masthead-pulse-text`, `.tug-pulse*` class families and `--tugx-pulse-*` knobs are renamed to the beat, the activity card, and the activity line; `publishPulseFrame` on the test surface is renamed and the surface version bumped; `PULSE_ENABLED_DOMAIN` is replaced by the one switch the Open Questions settle.
- *Rewrite the tests that drive the feed:* `at0498` becomes the digest feed's end-to-end test; the `publishPulseFrame` uses in `at0140`, `at0157`, `at0280`, `at0343`, and `at0551` move to the renamed surface call; `pulse-store.test.ts` and the `pulse-line` tests follow their modules.
- *Rewrite the prose:* [D103] is superseded ([B07]); [D132]'s pulse passages are amended to name the digest; every `[P09]` citation is resolved; the `tool_input_progress` comments in `tugcode/src/session.ts` and `types.ts` name the digester as the consumer; the theme files' sparkline comment says "activity sparkline".
- *The one exception:* `SessionActivitySparkline`, the activity meters, and `pulse-card.tsx`'s small-multiples are the **activity** instrument, fed by the `ACTIVITY` feed, and are untouched except for the rename. They were only ever named for the strip they sat beside.

The check for this decision is mechanical: `rg -i pulse` over `tugcode/`, `tugrust/`, `tugdeck/src/`, `tests/`, `tugapp/`, the scripts, and the `Justfile` returns nothing but the sparkline's own CSS animation and the Swift launch animation in `MainWindow.swift`, which pulse in the ordinary English sense.

---

## Open Questions {#open-questions}

- **Whether the Overview's own `pulse/enabled` gating survives.** Today the beat hides under `dev.tugapp.pulse/enabled` and the synopsis under the `synopsis` tenant. With one producer there should be one switch. Which key survives, and what a disabled state shows on the masthead line, is the arc's to settle from the settings surface.
- **The wake for a session that never ends a turn.** With a 60 s sitrep the masthead's upper line refreshes on the same clock the synopsis did, but the first post of a turn arrives no sooner than 60 s after the turn starts. Whether the intent line should carry the user's ask until the first post lands is a reading the arc should try on the running app.

---

## Non-goals {#non-goals}

- **A model-written beat.** Rejected. The instant line stays deterministic [B02]; [D103]'s nine prompt versions are the record.
- **Tuning the existing voice in place** (forwarding the submission wire to the daemon, letting it read results). Considered as Option 1 and rejected: it leaves three producers and two digesters standing, and the line is still stitched from fragments.
- **Keeping the tugpulse daemon as the digester.** Rejected with the TypeScript parse [B02]; two languages on one wire is the shape being removed.
- **A second per-stretch headline line.** [D132] retired the headline chain and says do not rebuild it. The Observer post on the masthead's upper line is the one written line, replacing the pinned intent, not standing beside it.
- **Changing the Operator.** `operator-retrieve` and `operator-answer` read the ledgers and are untouched.
- **Retention or schema changes to `facts`, `overview_posts`, or `prompt_history`.** The digest is in memory; the ledgers keep what they keep. The one schema change is the drop of `pulse_lines` [B09].
- **Touching the activity instrument.** The sparkline, the meters, the `ACTIVITY` feed, and the small-multiples popover measure the session; they are renamed out of the pulse's vocabulary [B09] and otherwise left alone.

---

## Exit {#exit}

**An arc**, in two landings that must stay in order.

The first landing is [B01]–[B04] and the daemon's retirement: a Rust digester module with a fixture test against recorded frames; `pulse.rs` rewritten to emit the digest's newest line on the `PULSE` feed in the shape `pulse-store.ts` already folds; `observer_wake.rs`'s `FrameBuffer` and `session_synopsis.rs`'s activity lines switched to read it; `tugcode/src/pulse/` deleted along with its spawn path and its 982 lines of tests; the `overview_replay` harness re-pointed at the digester so its calibration stays honest. Every surface reads the same at the end of this landing, which is the check.

The second landing is [B05]–[B09]: the envelope field, the deletion of the synopsis job and module, the 60 s cadence, the masthead's upper line reading the newest post, the pulse residue removed, the [F12] checklist closed line by line with the `rg -i pulse` check at the end of it, and the doctrine rewritten. This landing changes what the reader sees and is vetted on the running app, on an open card, a minimized card, and the Cards rows.
