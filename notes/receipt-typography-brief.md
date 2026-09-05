# Receipts are prose, not terminal output

**Purpose:** The `/commit`, `/arc-join` and Wheel receipts are typeset as if the Session card were a fixed-width terminal — English set in mono, a hanging indent measured in `ch`, and a raw claude session id standing where a name belongs. Each is the same premise showing through, and the app's own doctrine already contradicts it on every other surface.

---

## Purpose {#purpose}

Three faults reported off one screenshot of a Session card:

> 1. The commit message text in the transcript should use a *proportional* font, not a monospace, right?
>
> 2. The session identities here *must not* use this invented and undesigned style with huge fonts. *We have* a properly designed atom for sessions, right? We should be using that, and identifying these sessions *by their names*, not their UUIDs (which we don't do *anywhere else* in the app).
>
> 3. The text here should run to the full line, and not be limited by the … *tab stop* as it is in this example. There is no good reason for that.

On the second, once the id's provenance was traced, the report sharpened:

> This isn't a *session* in my sense of the word at all. It's a leakage of irrelevant data that the user never needs to see. This claude id should not appear in the user interface at all. What's more … the session identity would be the *same* for all those lines and would be the session for the card the user is looking at, so it doesn't make sense to copy this onto every line. On that right side, maybe we should put a token count and time instead of this session ID.

On how those numbers are to be found:

> I don't want to change *anything* about how this works. I just don't want to be showing these claude IDs to the user. … Staying permanently blank on the right is a non-starter. We need a simple/standard/reliable way to get these numbers.

And on the one horizon past which the ledger had no numbers to give:

> Why 90 days? That number means nothing. We picked this out of the air for no reason. Can we move this to a year? Why not? Why not forever?

The three faults are one premise. Mono for prose, a `ch`-measured indent, and an object named by hex are all things you do when the surface is a fixed-width grid. The Session card is not one.

---

## Evidence {#evidence}

### The face

**[F01] One scope class dresses two surfaces that want opposite things.** `.tugx-commit` (`tugdeck/src/components/tugways/commit-presentation.css`) is worn both by the History shade's compact mono rows and by the transcript's `/commit` and `/arc-join` receipts. It publishes mono for both: `--tugx-commit-subject-font: var(--tug-font-family-mono)` at line 35, and `.tugx-commit-message { font-family: var(--tug-font-family-mono) }` at line 128. `.join-receipt-identity` (`session-join-receipt-block.css:52`) pins mono a second time for the `arc → base` line. **(verified — read out of the sheets)**

**[F02] The law already says a receipt is proportional, and the one component that obeys it is defeated by [F01].** [`tuglaws/entity-presentation.md`](../tuglaws/entity-presentation.md) line 128, writing about the commit atom: "The pill … reverses that single declaration and inherits: proportional in a transcript paragraph, an Overview post and **a receipt header**, monospace in the History shade's mono rows, reading as the ink around it does." `tug-commit-atom.css:51` implements that as `font-family: inherit`. The pill therefore inherits whatever the surface sets — and the surface sets mono. The atom is correct; the sheet it reads from is not. **(verified)**

**[F03] Three things on these surfaces are legitimately mono and must survive.** The stamp (`--tugx-commit-stamp-font`, carrying `tabular-nums` so dates and times stack into a column), a `code` run inside a message body (the author's own backticks — `entity-presentation.md` line 42: code tone means *the author formatted this as code*), and the file rows beneath the message. **(verified)**

### The tab stop

**[F04] The hanging indent's stated premise is false on a receipt, in both halves.** `commit-presentation.css:29–31` says it outright: "The hanging indent for a wrapped subject: the content column is mono, so the 8-char sha + its single separating space measure exactly 9ch" → `--tugx-commit-hang: 9ch`, applied at line 60 as `padding-left` + negative `text-indent`. But the column stops being mono under [B01], and `ch` in a proportional face measures the width of a `0` — the width of nothing in particular; and the sha has not been eight bare characters since the commit atom became a pill on every surface, a box with padding, a border and a glyph. `session-commit-receipt-block.css:21` restates `text-indent: -9ch` locally. **(verified)**

**[F05] Two rules exist only to survive the indent, which is the tell.** `tug-commit-atom.css:23` and `tug-session-identity.css:55` both set `text-indent: 0` on the chip, and the latter says why: "`text-indent` inherits, and an `inline-flex` is its own block … applied that indent to its OWN first line." A third dependent is documented at `tug-history-list.css:53`. **(verified)**

**[F06] One surface already reasoned this out and corrected itself.** `session-join-receipt-block.css:16–21`: "It carries no hanging indent for the same reason the boundary's slot flows normally — a wrapped subject returns flush under the event rather than hanging under wherever the sha ended, **which is the correction the boundary exists for**." The argument for [B02] is already written in this repository; it was simply never generalised to the receipts beside it. **(verified)**

### The id

**[F07] The id on the stage row is a claude session id, and it is one by construction.** The arc log's `arc-stage` note is written at `tugrust/crates/tugcast/src/feeds/agent_bridge.rs:1593` from `segment.new_session_id`; `tugarc-core/src/arc.rs:394` types it as "which stage started, on which claude session"; and `ArcRecord::dispatched`'s own doc comment says why the bridge alone can write the line: "it names a claude session id nobody knows until claude announces it." The deck renders it at `session-arc-receipt-block.tsx:441`. Nothing about this is wrong as a *record*; it is wrong as *ink*. **(verified)**

**[F08] The user's inference is correct: the session identity is one, and it is the card's.** Both stage segments of the `atom-selections` arc resolve to a single line:

```
$ just db-inspect …/sessions.db "SELECT session_id, stage_label, line_id, turn_count FROM sessions WHERE session_id LIKE '0431f0dd%' OR session_id LIKE '557d7058%'"
557d7058-8076-…|implement|12287084-3775-49b8-9ddf-43852320601b|10
0431f0dd-cb36-…|audit    |12287084-3775-49b8-9ddf-43852320601b| 1
```

The `sessions` table is keyed by **segment** (claude session id); the shared `line_id` `12287084…` is what carries the callsign, and the commit trailer on the same screenshot reads `Tug-Session: frigid-ladle (12287084)`. So every stage row of an arc would render the same name — the name of the card the reader is already looking at. **(verified)**

### Where the numbers are

**[F09] The id that is useless as ink is the exact key that fetches what would be useful.** `turn_telemetry` (`session_ledger.rs:1982`) is keyed `(session_id, msg_id)` where `session_id` is the segment id, and carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `total_cost_usd`, `wall_clock_ms` and `active_ms` per committed turn. Summed over the two segments above:

```
0431f0dd (audit)     | 1 turn  |   121,868 tokens |  415s active
557d7058 (implement) |10 turns | 1,885,093 tokens | 1391s active
```

`415s` is `6m 55s`, which is exactly the duration the audit stage's own agent footer already prints in the reported screenshot. **(verified — a live read of this machine's ledger)**

**[F10] `total_cost_usd` is not reliably populated.** In the same read, the implement segment carries `11.07` and the audit segment carries `0.0` for a stage that plainly cost something. **(verified)**

**[F11] The arc log carries a per-stage timestamp; it does not carry tokens or time.** `ArcStageLine` (`tugarc-core/src/arc.rs:396`) is `{ stage, session_id, model, at }`. Any token or duration figure comes from the ledger via [F09], not from the log. **(verified)**

**[F12] The receipt is a durable text row, parsed by the deck.** `record_arc_receipt` (`agent_supervisor.rs:7385`) writes the summary as a landing-receipt row in the shell ledger and broadcasts a live `arc_receipt` frame carrying the same text; the deck's `changeset-verb-store.ts:497` records the live copy, and on restore the row arrives as durable ink. Either way `parseArcReceipt` reads the stage lines out of the text with `STAGE_RE`. The stage ids are therefore already in the deck's hands at render time, on both paths. **(verified)**

**[F13] The deck already has a standard path for "a rendered thing needs a ledger fact about a session id it holds."** `resolve_sessions` (CONTROL, [D132]) takes a batch of ids — full uuids or 8-char short forms — and answers with each one's `SessionRow` plus a named list of misses. `session-citation-store.ts` is the cache in front of it: ask once per id, batch on a microtask, cache hits *and* misses, seed the identity stores from the answer, forget on reconnect. `TugSessionCitation` is its consumer. `resolve_session_ids` reads the `sessions` table, whose rows *are* segments ([F08]), so a stage id resolves as-is. **(verified)**

**[F14] `session_updated` is already the app's rule for "a ledger write happened; here is the row".** `action-dispatch.ts:1370`: "tugcast supervisor broadcasts these on every ledger write (`record_spawn`, `record_turn`, `mark_closed`, `mark_failed`, `trash`)." `build_session_updated_frame` (`agent_supervisor.rs:1501`) builds the push, and its doc states the rule every caller follows: the scan-derived pair `SessionScanMetrics { file_size, turn_count }` is looked up by **every** caller, "not just the one pushing after a turn," because "the client replaces its cached row wholesale on a push, so a push that omits a fact downgrades it." That is the precedent for a fact that lives outside the `sessions` row but rides it on the wire. **(verified)**

**[F15] The telemetry write pushes nothing, and the after-turn push predates it.** `do_record_turn_telemetry` (`agent_supervisor.rs:8992`) resolves the tug session to its live segment, writes the `turn_telemetry` row, and returns — no frame. The row is written from the deck's `record-telemetry` effect, which `handleTurnComplete` dispatches *after* the turn commits (`reducer.ts:2713`), so it lands one round trip after the boundary the existing after-turn `session_updated` is emitted at. Any aggregate carried on that existing push would therefore miss the turn that just ended. **(verified)**

**[F16] The receipt is composed at the same boundary, so a compose-time snapshot would carry the same gap.** `arc_runner.rs:2675` composes the finished-arc receipt on an idle reading confirmed "a settle later," then hands the card back. The final turn's telemetry row is racing that settle. Folding numbers into the receipt text when it is written would bake in a total missing the last turn for the stage that just finished — and a baked number that a later live lookup contradicts is worse than either alone. **(verified — from the ordering in the code; not timed)**

### The horizon

**[F17] The telemetry lives exactly as long as the segment's row, and the row's life is bounded by one age sweep.** `session_ledger.rs:27`: "One policy, and it is age." `sweep_expired` removes non-live `sessions` rows whose `last_used_at` is older than `DEV_LEDGER_MAX_AGE_DAYS = 90` (line 219), applied at tugcast startup from `main.rs:1248`, and `turn_telemetry` cascades with the row (line 1973: "eviction of a `sessions` row … takes its telemetry with it"). The receipt row lives in the shell ledger, a separate database (line 4823), and is not swept with the session. So a receipt can outlive the numbers behind it — after ninety days, and only then. **(verified)**

**[F18] The ninety days defends nothing.** Three facts, all read off this machine's live ledger. *What the sweep removes is tiny:* `sessions` holds 261 rows and `turn_telemetry` 727 across six months of use — with the turns journal and `file_events`, some hundreds of kilobytes. *What is large is not swept:* the ledger is 198 MB, of which `facts` is 120 MB and its indexes another 35 MB; `delete_session_events` cascades into `file_events` and `file_event_spans` and nothing else — there is no cascade from a `sessions` row into `facts`, so the sweep has never bounded the one table that has size. *The constant has no argument behind it:* it is named `DEV_LEDGER_MAX_AGE_DAYS`, introduced in May 2026 as a dev-card setting, and its only later edit added the guard that stops it taking a user's name. The ledger's own header already made the case against its sibling: the per-workspace row cap "outlived that rationale: it evicted the last segment of a line the user had named by hand. A bounded row count is not a resource this ledger needs to defend, and no number is small enough to be worth a name." The age policy is the same argument one step further along. **(verified)**

**[F19] Tug already keeps one ledger forever, as doctrine.** `prompt_history.db` has no retention policy at all — `CLAUDE.md`: "nothing trims it, and any change that would drop, cap, or expire a row is a bug in the feature, not a tuning knob." The `sessions` table's segments are the same kind of record: the user's own history, small, and referenced by durable ink. **(verified)**

### The atom

**[F20] The stage row hand-rolls an identity the app has a designed component for.** `session-arc-receipt-block.tsx:441` renders `TugAtomRef entity={{ kind: "session", id }}`, whose label is minted by `sessionAtomLabel` as `session:<8 hex>`. `lib/atom-register.ts` names this exact row in its own header as the case that motivated collapsing the atom register to one row: "… and the arc receipt, **hand-rolling the block**, drew a 22px pill under a reading-scale line." `at0513-atom-surfaces-one-height` measures five surfaces against that number; this row is a sixth that no test looks at, because it is not wearing the atom. **(verified)**

**[F21] The oversized rendering has a mundane cause.** `.arc-receipt-stage-word` and `.arc-receipt-stage-model` each set `font-size: var(--tug-font-size-xs)`; `.arc-receipt-stage-session` sets no size at all, and `TugAtomRef` is `font-size: inherit`. The cell inherits the block's base size and renders larger than the two cells beside it. **(verified)**

**[F22] The `session` arm of `TugAtomRef` has exactly one consumer.** A tree-wide grep for `TugAtomRef` finds `kind: "file"` and `kind: "arc"` at several sites and `kind: "session"` only at `session-arc-receipt-block.tsx:441`. **(verified)**

---

## Decisions {#decisions}

### The face and the tab stop

**[B01] Split `.tugx-commit`'s face by surface: the receipts take sans, the History shade keeps mono.** The scope class is worn by two surfaces with opposite needs ([F01]), and the law already states which way each goes ([F02]). Splitting rather than overriding per-site is what keeps the shade from moving and keeps the next person editing the shade from silently re-breaking the receipt. The subject and the message body change face; the stamp, inline `code` runs and the file rows do not ([F03]). `tabular-nums` on the sha survives and, as `entity-presentation.md` notes, earns more in proportional type than it did in mono.

**[B02] Remove the hanging indent from the receipt surfaces; the History shade keeps it.** Its premise is false there in both halves ([F04]), the correction is already argued in the codebase ([F06]), and in the shade the premise still holds — the column really is mono and the sha really is bare text, where the hang is what makes a wrapped subject read as one entry rather than two. Wrapped subject lines on a receipt return flush to the block's left edge and the line runs the full width.

**[B03] Retire the two `text-indent: 0` patches last, and only after the History shade is confirmed unaffected.** They defend against an inherited indent ([F05]) that the shade still sets, and the pill still lands in those rows. Removing them in the same breath as [B02] would be removing a guard on the evidence that one of its two callers no longer needs it.

### The id and the numbers

**[B04] The claude session id leaves the user interface. Nothing about how it is recorded or used changes.** It is an internal join key ([F07]), and even resolved to its name it would print the same name on every row of an arc — the card already in front of the reader ([F08]). Nothing in the app names an object by hex where a name exists. The arc log, `ArcStageLine`, `format_arc_receipt`, `STAGE_RE` and every other place the id is written or read stay exactly as they are; the id keeps doing the one thing it is good for, which is [B05].

**[B05] The trailing cell shows the stage's token count and its active time, keyed by the segment id the record already holds.** [F09] — the id stops being ink and becomes the lookup. Tokens and time are the two facts that differ per stage, they are already the app's own idiom for a finished unit of agent work (the agent footer on the same screenshot prints exactly this pair), and `formatTokensApprox` (`lib/code-session-store/compaction.ts`) already formats one of them. *Tokens* is the sum of all four token columns — the total the model consumed, which is what the app's other token figures mean. *Time* is `active_ms`, not `wall_clock_ms`: it is what the agent footer prints, and [F09] confirms the two agree for these segments.

**[B06] Cost is not shown.** [F10] — populated for some models and zero for others, and a money figure silently wrong on half the rows is worse than no figure.

**[B07] The ledger owns one per-segment aggregate, `SessionUsage { turns, tokens, active_ms }`, read by a single `SUM` over `turn_telemetry`, and it rides the session row on the wire exactly as `SessionScanMetrics` does.** This is the whole of the new plumbing, and it is one new fact on one existing shape. The precedent is [F14]: a fact that lives outside the `sessions` row and is looked up by every builder of a session-row frame so that no push ever downgrades it. `usage_for(session_id)` sits beside `scan_metrics_for`, is `None` where no telemetry exists, and `build_session_updated_frame` and `do_resolve_sessions` both carry it. `SessionRow` (Rust and TS, "keep in lockstep") gains the optional field and `normalizeSessionRow` decodes it; nothing else on the wire changes. The plan may choose to carry it as a sibling object beside the row rather than a field on it; the contract is the same either way and the field is the simpler of the two.

**[B08] The live path is a `session_updated` push from the telemetry write itself.** [F15] — `do_record_turn_telemetry` is the one ledger write that pushes nothing, and it is the write whose fact the receipt needs. Adding the push there is not a new mechanism; it is the existing rule ("every ledger write pushes the row", [F14]) applied to the one write that was exempt. It also closes the race in [F16] without any ordering argument: the receipt renders whatever the store holds when it mounts, and the push that lands after it moves the number. One push per committed turn is the cost, and the after-turn push already exists at that cadence.

**[B09] The deck holds usage in a store keyed by segment id, filled from `resolve_sessions_ok` and `session_updated`, forgotten on `removed`, and the receipt row asks for its stage ids through `sessionCitationStore`.** Keyed by *segment*, deliberately, where every identity store is keyed by line ([F14]'s handler files name and tag under the line): usage is the segment's own fact, and the stage row is asking about a segment. The pattern is `session-name-store.ts` — a small map, `useSyncExternalStore`, authoritative from pushes, filled by asks. The receipt row becomes one more caller of the citation store's ask machinery ([F13]), which already batches the row's several ids into one request, never re-asks an answered id, and forgets on reconnect. No new verb, no new request shape, no polling.

**[B10] Relaunch needs nothing special, which is the point of [B07]–[B09].** On restore the receipt ink mounts, the row asks `resolve_sessions` for the ids it parsed, and the ledger sums the telemetry for the segments ([F12], [F13]). The `atom-selections` receipt on this machine would acquire the numbers in [F09] on its next relaunch with no other change. A receipt is never blank on the right while the ledger holds the segment — and under [B13] the ledger holds it until the user trashes it.

**[B11] The receipt text does not carry the numbers.** [F16] — a compose-time snapshot races the last turn's telemetry and would bake in a wrong total for the stage that just finished; a second source of the same figure is a drift the app would then have to adjudicate. The ledger is the single source, and the row is read, not copied. This also keeps [B04]'s promise that the record does not change.

**[B12] The atom's `session` arm is deleted, and the cell takes the size its siblings declare.** [F20], [F22] — the arm is a duplicate identity rendering with a single call site, and [B04] removes that site. `sessionAtomLabel` goes with it; `TugAtomRef` keeps `file` and `arc`, which are read-only refs with no identity record behind them, which is what that skin is for. `.arc-receipt-stage-session` sets `font-size: var(--tug-font-size-xs)` ([F21]) whatever ends up in it.

### The horizon

**[B13] The age sweep over `sessions` is removed. A segment's row, and the telemetry under it, live until the user trashes the session.** [F18] — the sweep costs the receipt its numbers and buys nothing: the tables it bounds are a rounding error, the table with size is untouched by it, and the number was never argued for. A year would be the same arbitrary number with a different spelling; the honest reading of "why not forever" is that there is no reason not, and [F19] says the app already holds that position for a ledger of the same kind. `trash` — the user's explicit gesture — remains the one act that removes a row, exactly as the ledger's header says it should be, and the `sparing_named_lines!` guard becomes moot rather than wrong. `DEV_TRASH_SWEEP_AGE_DAYS` (7) is a different policy about recoverable JSONLs under `~/.claude` and is not touched. With this, the question of what a receipt shows once the ledger has forgotten a segment has no case to answer: the ledger does not forget. The receipt's only empty-right-hand state is a segment that genuinely recorded no telemetry.

---

## Open Questions {#open-questions}

None. The one question the first draft left open — what a receipt shows once the ledger has forgotten the segment — was answered by measuring what the forgetting protected ([F18]) and is now [B13].

---

## Non-goals {#non-goals}

- **The History shade's typography.** It is a dense mono scanning grid and it is correct. Every change here is scoped to the receipt surfaces, and the reason [B01] splits the scope class rather than editing it is precisely so the shade does not move.
- **The commit atom's own face rule.** `entity-presentation.md` line 128 is right and is not being amended. It says the pill inherits its surface; [B01] fixes the surface so that inheriting produces what the law already describes.
- **Changing how the claude id is recorded, logged, or parsed.** Rejected under [B04] in the user's own words: nothing about how this works changes; the id stops being shown.
- **Resolving the claude id to a name.** Considered and rejected under [B04]: it would render correctly and still say the same thing on every row, about a card the reader is looking at.
- **Baking the numbers into the receipt text.** Rejected under [B11], on [F16].
- **Showing cost.** Rejected under [B06], on [F10].
- **A longer age — a year, or any other number.** Rejected under [B13]: a different arbitrary figure inherits the same defect, and there is nothing for it to defend ([F18]).
- **Retaining `turn_telemetry` selectively for segments a receipt names.** Considered as a narrower fix and rejected: it would be a second retention rule carved for one surface, on top of a first that protects nothing. Removing the first is simpler and answers every surface at once.
- **A new CONTROL verb or a per-receipt query.** `resolve_sessions` already answers "what does the ledger know about these ids" in batches with a cache in front of it ([F13]); a second verb for a second fact about the same ids is the shape the citation store was written to avoid.
- **Summing telemetry client-side from replayed turns.** The deck does hold per-turn telemetry for turns it has loaded, but only for the segments the replay carried and only the pages loaded; a number that depends on how much of the transcript is paged in is not a fact about the stage.
- **The `at0474` arc transcript corpus.** The receipt's parse grammar is untouched; this is a rendering change over the same parsed record.

---

## Exit {#exit}

**A plan.** One phase, three steps, in this order — [B01] first because [B02]'s argument depends on the face having changed, and the stage row is independent of both.

1. **Split the face.** A receipt scope (or modifier) carrying sans for the subject and the message body, the History shade unchanged; stamp, inline `code` and file rows stay mono. [B01], [F03].
2. **Drop the hang on the receipt surfaces**, including the local restatement in `session-commit-receipt-block.css`, then retire the two `text-indent: 0` patches once the shade is confirmed green. [B02], [B03].
3. **Rebuild the stage row's trailing cell** as tokens + active time. Ledger side: the age sweep removed [B13]; `usage_for` and the field on the row, carried by `build_session_updated_frame` and `do_resolve_sessions`; and the push from `do_record_turn_telemetry` [B07], [B08]. Deck side: the segment-keyed usage store, the receipt row asking through the citation store, the cell at `xs`, and the deletion of `TugAtomRef`'s `session` arm with `sessionAtomLabel` [B09], [B10], [B12].

What the plan should pin:

- A **pure test** over the receipt scope: subject and message body resolve to the sans family while the stamp resolves to mono — the regression anyone editing `.tugx-commit` for the shade would otherwise re-introduce.
- **`at0513-atom-surfaces-one-height` gains the arc receipt's stage row** as a sixth surface — the measurement that would have caught [F20] the day it was written.
- **Ledger tests** for `usage_for`: the sum over several rows, `None` for a segment with no telemetry, and the cascade — a trashed segment answers `None` rather than a stale sum.
- **The sweep's own tests go with it.** `sweep_expired_*` in `session_ledger.rs` and the startup call in `main.rs` are deleted, not disabled; the ledger's module header is rewritten so it no longer describes an age policy; and a test that no automatic path deletes a `sessions` row is the pin. [B13].
- **A supervisor test** that `record_turn_telemetry` is followed by a `session_updated` for the segment carrying the post-write usage, and that `resolve_sessions_ok` carries it for a resolved id. [B07], [B08].
- **A deck test** on an old three-field receipt: the row asks for its stage ids, an answer with usage fills the cell, an answer naming the id as unknown (a trashed segment) leaves the stage and the model standing with no figure. [B10].
- An **app-test on the arc receipt** asserting the trailing cell reads as a token figure and a duration and that no `session:` string appears in the block.
- **No test on the hang.** It is a removal, and the surfaces that keep it (`at0512-commit-atom-surfaces`, the History rows) already assert it where it still applies.

The phase boundary is the join: nothing here is separable into two landings, since [B01] and [B02] are one visual change to one surface, and step 3's ledger and deck halves are one contract.
