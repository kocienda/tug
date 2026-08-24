<!-- devise-skeleton v4 -->

## Partial File Claim Fixup {#partial-file-claim-fixup}

**Purpose:** Make hunk-aware SHARED placement actually fire in the field: record Edit anchors as the *added lines* they will appear as in the diff, let one anchor claim several hunks, and split the widening rule so an unplaceable anchor widens the SHARED badge but narrows the default election — so a SHARED file lands "the regions I can prove are mine" instead of silently landing the co-owner's work.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented (dash `partial-file-claim-fixup`) |
| Target branch | main |
| Last updated | 2026-08-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The hunk-aware SHARED feature (changes-rework M03, landed `a889ff720`, hardened `0d95ab38d`) is wired end to end but almost never fires on real edits. The measurement in [dash/partial-file-claim-fixup-brief.md](partial-file-claim-fixup-brief.md) replayed 400 real span rows from the live `changes.db`: **78 of 82 owner/path pairs widened to a whole-file claim** (≤73% span-level failure; the causes are structural regardless of the exact rate). The visible tell is a SHARED row with no `N of M hunks` badge — the session is claiming the whole file, and `ChangesRouteController.commit` faithfully lands exactly that, taking the co-owner's work under this session's message.

Three structural causes, each fatal alone (brief §"Why the evidence cannot place an edit"): **C1** — `spans_for_tool_input` (`tugrust/crates/tugcast/src/feeds/attribution.rs`) records the raw `Edit.new_string`, which carries unchanged context lines that the diff renders as context, not `+` lines, so neither the hash nor the head of the anchor appears in the hunk's added text. **C2** — the `content_matches` length floor (`tugrust/crates/tugchanges-core/src/contention.rs`) compares the hunk's added bytes against the *entire replacement's* bytes, so a large `new_string` that rewrites a few lines fails even when the head matches. **C3** — one edit legitimately spans several hunks (import + call site), and `claim_for` treats a multi-match as ambiguity and returns `Claim::Whole`. Compounding all three, `claim_for` is all-or-nothing: one unplaceable anchor widens its owner to the whole file. The tests are green because every fixture mints its anchor *from the added text* — a shape production never produces.

#### Strategy {#strategy}

- **Fix the evidence at the source, not the matcher's tolerance.** At record time, derive the *added lines* of `old_string → new_string` and store their per-line hashes plus a capped head and a line count. The anchor then has the same shape as the hunk's added text it is compared against ([P01], Spec S01).
- **Share the derivation.** The added-line derivation and anchor construction move into `tugchanges-core` (new `anchors` module), so the relay (`tugcast::feeds::attribution`) and the contention tests both call the one production function — the tests can no longer test a shape production never writes ([P02]).
- **Match per line, claim every match.** A hunk matches an anchor when any of the anchor's distinctive line hashes appears among the hunk's added lines, with a text-containment fallback for fragments the hash rule cannot reach ([P06]). Multi-match claims all matched hunks — conservative *within* the file ([P03]).
- **Split the widening rule.** `Claim` learns the difference between "placed here" and "wrote something unplaceable": the SHARED badge and `contested` widen on unplaceable evidence, the `own_hunks` election carries only the hunks actually placed ([P04]).
- **Legacy rows keep legacy matching.** Old-shape anchors (`new_hash`/`new_head`/`new_len`) already in live ledgers keep the existing `content_matches` path unchanged; they benefit from F2/F3 (multi-match, split widening) but nobody rewrites history ([P05]).
- **Regression-gate with real-shaped fixtures.** New contention tests build anchors via the production constructor; a tugcast compose test drives `spans_for_tool_input` on an Edit-shaped input with context lines end to end (F4).

#### Success Criteria (Measurable) {#success-criteria}

- The brief's real ledger example places: an Edit whose `new_string` is `"            glyphPosition=\"both\"\n            size={12}"` with `old_string` differing only in the `size` line, against a hunk whose added text is `"            size={12}"`, yields a claim on exactly that hunk. (Unit test in `contention.rs` using the production anchor constructor.)
- A 1166-byte `new_string` that rewrites ~60 bytes of one line places into the hunk carrying that line (C2 dead). (Unit test.)
- One Edit adding an import and a call site — two hunks — claims *both* hunks, not `Whole` (C3 dead). (Unit test.)
- An owner with one placed anchor and one unplaceable anchor gets `shared == true` against a co-owner *and* `hunks_of` returns only the placed hunk (F3). (Unit test.)
- A sub-line edit (`old_string`/`new_string` both mid-line fragments, no newline) places via the containment fallback ([P06]). (Unit test.)
- An anchor whose only added line is `});` places nothing and does not claim a co-owner's hunk that also added `});` ([P03] distinctiveness rule, Risk R01). (Unit test.)
- End to end: `compose_snapshot` over spans written by `spans_for_tool_input` on context-carrying Edit inputs yields `own_hunks` that is a strict subset of the file's hunks — the shape that renders the `N of M hunks` badge via `defaultElection`. (tokio test in `tugcast/src/feeds/changeset.rs`.)
- `cd tugrust && cargo nextest run` green with `-D warnings`.

#### Scope {#scope}

1. New `anchors` module in `tugchanges-core`: added-line derivation, anchor JSON construction, head/line-hash caps.
2. `contention.rs`: new `Anchor::AddedLines` variant, per-line matching, multi-match claims, `Claim` split into placed/unplaced, `hunks_of` narrowing.
3. `tugcast/src/feeds/attribution.rs`: `edit_spans` writes the new anchor shape via the shared constructor.
4. Tests at both layers whose fixtures are built by the production anchor constructor / `spans_for_tool_input`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **`hunk`-kind anchor drift.** Verb-receipt `hunk_spans` anchors still widen (now: mark unplaced) when their id drifts; a content-matching fallback after id drift is a separate question (brief §"Out of scope").
- **No tugdeck changes.** `defaultElection` (`tugdeck/src/lib/hunk-election.ts`) already renders the badge when `own_hunks` is a strict subset; the fix is entirely in what the server sends. No frontend state is added, so no State Zone Mapping.
- **No wire or schema changes.** `ChangesetFile.own_hunks`/`contested_hunks`/`shared` keep their shapes; the span `anchor` column is free-form JSON text, so no `CHANGES_SCHEMA_VERSION` bump and no migration.
- **No commit-routing change.** SHARED files whose election covers every hunk still route through `stage_partial_and_commit` (brief §"Secondary consequence"); making that route cheaper or bypassable is follow-on work.
- **No rewriting of existing ledger rows.** Legacy-shape spans stay as recorded.
- **Not closed: the owner whose evidence places *nothing*.** F3's narrowing is invisible when it narrows to empty. `defaultElection` reads `own_hunks: []` as whole-file (`if (own.length === 0) return { elected: ids, partial: null }` in `tugdeck/src/lib/hunk-election.ts`), and `ChangesRouteController.commit` then sends no `hunks` key for the path, staging it whole. So an owner *all* of whose anchors fail to place still lands the co-owner's work exactly as today. F3 earns its keep only in the mixed case — some anchors placed, some not — which the brief's numbers say is the common one (182 no-match spans against 68 placed). Closing the all-unplaceable case needs a wire signal distinguishing "no evidence" from "evidence that failed to place", which is a protocol change and a deck change; it is named in #roadmap and deliberately not attempted here.

#### Dependencies / Prerequisites {#dependencies}

- `tugchanges-core` already depends on `serde_json` and exports `content_hash` (`tugrust/crates/tugchanges-core/src/hunks.rs`) — the anchors module reuses both.
- `tugcast` already depends on `tugchanges_core` (calls `tugchanges_core::hunks::content_hash` from `attribution.rs`).

#### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml` enforces `-D warnings`).
- The conservative direction differs by consumer and the code must keep them straight: for the **SHARED bit and `contested`**, widening is conservative; for the **election**, narrowing is conservative ([P04]).
- `classify_contention` must stay a pure function over `(hunks, per-owner anchors)` — two independent readers call it (`tugchanges_core::changes::paths_contend` sync, `tugcast::feeds::changeset::contention_verdict` async) and neither may grow side effects.
- Ledger spans persist across app versions: decode must accept both the legacy and the new anchor JSON shapes indefinitely.
- **The decoder ships before the writer.** #step-2 (read) must land before #step-3 (write); the reverse order opens a window in which every Edit-owner widens to a whole-file claim (Risk R04).

#### Assumptions {#assumptions}

- A line present in `new_string` but absent from `old_string` will appear as a `+` line in the working-tree diff of that region, unless a later edit overwrote it — in which case failing to place is the correct answer and F3 keeps the failure cheap.
- **Edit strings are usually line-aligned** — `old_string`/`new_string` begin and end at line boundaries, carrying full leading indentation. Measured, not assumed: see #live-ledger-shape. Where they are not, [P06]'s containment fallback covers the fragment.
- `file_event_spans` lives in the **machine-global `changes.db`** only, created as `changes.file_event_spans` by `tugcast/src/session_ledger.rs` ([D112]). The per-instance `sessions.db` has no such table. Both readers (`file_event_spans_for_paths` async, `tugchanges_core::ledger::spans_for_path` sync) read it from there, and the `anchor` column is `TEXT` holding opaque JSON — nothing but `Anchor::from_span` interprets it.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should legacy Content anchors get the C2 length-floor fix too? (DECIDED) {#q01-legacy-length-floor}

**Question:** Old rows carry `new_len` (whole-replacement bytes); should `content_matches` stop applying the mis-unitted floor to them?

**Why it matters:** Legacy rows in live ledgers will keep failing to place until the file is re-edited under the new relay.

**Resolution:** DECIDED (see [P05]) — leave legacy matching byte-for-byte unchanged. A legacy row that fails to place degrades to exactly today's behavior, and F3 caps the damage (the election no longer widens). Loosening the floor retroactively risks new false placements on evidence we already know is mis-shaped.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Trivial-line cross-matching over-claims a co-owner's hunk | high | med | Alphanumeric-plus-length distinctiveness rule ([P03], R01) | A field report of an election containing a hunk the session never touched |
| Added-line derivation records a line git renders as context | med | low | Multiset subtraction under-approximates (R02) | A placed anchor asserting a hunk with none of its lines |
| Legacy rows keep widening until re-edit | low | high | F3 narrows their election damage; accepted (R03) | — |
| Writer ships before decoder; a stale binary reads new anchors | med | med | Step ordering + benign decode direction (R04) | Every Edit-owner suddenly badgeless again |

**Risk R01: Trivial lines match everywhere** {#r01-trivial-lines}

- **Risk:** An anchor line like `}` or a blank line appears in a co-owner's hunk's added lines, claiming their hunk into this session's `own_hunks` — the expensive, invisible direction, and the one failure mode this plan can *introduce* rather than merely fail to fix.
- **Mitigation:** The distinctiveness rule ([P03], Spec S01) is **both** a length floor *and* an alphanumeric requirement: a line qualifies only when its trimmed content is at least `ANCHOR_MIN_LINE_BYTES` (3) bytes **and** contains at least one alphanumeric character. A bare length floor is not enough — `});` is exactly 3 bytes and appears thousands of times in this codebase, as do `};`, `))`, and `---`. Requiring an alphanumeric excludes all of them while keeping genuinely short real lines (`id,`, `use std::fmt;`). An edit whose added lines are *all* indistinctive records an anchor with zero hashes, which places nothing and marks its owner unplaced.
- **Residual risk:** A distinctive-but-duplicated line (the same import added by both sessions) still cross-claims; that lands the hunk in `contested`, which is the honest reading (both wrote it).

**Risk R04: The writer outruns the decoder** {#r04-writer-before-decoder}

- **Risk:** New-shape anchors reaching a binary whose `Anchor::from_span` predates [P01] decode as `Anchor::Whole` — every Edit-owner silently widens to a whole-file claim, which is the very regression this plan exists to end. Two ways in: committing #step-3 before #step-2 and building the app in between (this repo builds and runs between commits routinely), and the `~/.local/bin/tug*` symlinks, which point at a `main`-built `tugutil` that may lag a rebuild.
- **Mitigation:** #step-3 declares `**Depends on:** #step-2` so the decoder always lands first. The residual direction is benign: a stale reader over-warns (file-level SHARED) rather than under-warning, and self-heals on the next rebuild.
- **Residual risk:** A window of over-warning on a machine with a stale `tugutil`. Acceptable — it is the pre-M03 behavior, not a new failure.

**Risk R02: Derivation over-approximates the added set** {#r02-derivation-overapprox}

- **Risk:** Recording a line as "added" that git renders as context would make matching fail exactly the way C1 does today.
- **Mitigation:** The derivation is multiset subtraction — `new_string`'s lines minus `old_string`'s lines, respecting multiplicity ([P01]). A line surviving subtraction did not exist in the replaced region, so the diff of that region must render it `+`. Under-approximation (a moved duplicate line dropped from the anchor) only reduces evidence, never corrupts it.
- **Residual risk:** A later edit that rewrites the region makes the anchor unplaceable — correct, and cheap under F3.

**Risk R03: Live ledgers hold legacy-shape rows** {#r03-legacy-rows}

- **Risk:** Rows recorded before this ships keep failing C1/C2 placement.
- **Mitigation:** None needed — they behave exactly as today for `shared`, and *better* than today for the election (F3 narrows). Spans age out with commits (row-liveness cut), so the population self-drains.
- **Residual risk:** None worth carrying.

---

### Design Decisions {#design-decisions}

#### [P01] Anchors record the edit's added lines, derived by multiset subtraction (DECIDED) {#p01-added-line-anchors}

**Decision:** At record time, an Edit's anchor stores the per-line `content_hash` of each line of `new_string` not present (by multiset) in `old_string`, plus a capped head of those lines joined and the total added-line count — replacing the whole-`new_string` hash/head/len.

**Rationale:**
- The comparison target (`added_text(hunk)` — the hunk's `+` lines) is a set of lines the file gained; evidence in the same shape matches exactly instead of heuristically. C1 and C2 disappear together (brief §F1).
- Multiset subtraction needs no diff algorithm and can only *under*-approximate git's added set (Risk R02) — the safe direction, since a false "added" line breaks matching and a missed one merely thins evidence.
- `insert` anchors (no `old_string`) unify: every line of `new_string` is added, so the same constructor serves both kinds.

**Implications:**
- New JSON shape (Spec S01) written under the existing `replace`/`insert` kinds; `Anchor::from_span` discriminates by field presence.
- `SPAN_HEAD_CAP` and `head_excerpt` move from `tugcast::feeds::attribution` into the new `tugchanges-core::anchors` module (single source; tugcast re-uses them).
- The unused `old_hash` field stops being written.

#### [P02] Anchor construction lives in tugchanges-core (DECIDED) {#p02-shared-constructor}

**Decision:** A new module `tugrust/crates/tugchanges-core/src/anchors.rs` owns added-line derivation and anchor JSON construction; `tugcast`'s `edit_spans` calls it.

**Rationale:**
- The crate dependency direction (tugcast → tugchanges-core) means `contention.rs` tests can't call `spans_for_tool_input`; hoisting the construction lets the core tests build fixtures through the *production* path — the gate F4 demands.
- Producer and matcher living in one crate makes shape drift a compile-adjacent failure instead of a field discovery.

**Implications:**
- `tugchanges-core/src/lib.rs` grows `pub mod anchors;` and re-exports.
- `attribution.rs` keeps `spans_for_tool_input`/`edit_spans` as the relay-facing surface but delegates anchor bodies.

#### [P03] A hunk matches on any distinctive line; multi-match claims all matches (DECIDED) {#p03-any-line-multi-match}

**Decision:** An `AddedLines` anchor claims every hunk whose added lines contain at least one of the anchor's line hashes. A line is **distinctive** — and so contributes a hash — only when its trimmed content is at least `ANCHOR_MIN_LINE_BYTES` (3) bytes **and** contains at least one alphanumeric character (`char::is_alphanumeric`); indistinctive lines are dropped at record time.

**Rationale:**
- Multi-match is the *normal* case for a real edit (C3: import + call site), not ambiguity; claiming both hunks is conservative within the file (brief §F2).
- Genuine ambiguity (identical distinctive text in two regions) costs one extra claimed-and-contested hunk instead of the whole file.
- The distinctiveness rule is the **only** guard on the expensive, invisible direction (Risk R01), so it must be stronger than a byte count: `});` is exactly 3 bytes and ubiquitous in this codebase, as are `};`, `))`, and `---`. The alphanumeric requirement excludes every one of them while admitting genuinely short real lines (`id,`, `use std::fmt;`).

**Implications:**
- `claim_for` accumulates matched hunk ids instead of returning `Whole` on `matched.len() != 1`; this applies to legacy `Content` anchors too (a legacy multi-match claims all matches — strictly narrower than today's `Whole`).
- An anchor with zero line hashes (an edit that added only punctuation or blank lines) places nothing and marks its owner unplaced.
- The rule is applied at **record** time only. The hunk side hashes every added line unfiltered — filtering there could only lose matches the anchor side already vouched for.

#### [P04] The badge widens, the election narrows (DECIDED) {#p04-split-widening}

**Decision:** `Claim::Hunks` becomes `Claim::Hunks { placed: BTreeSet<String>, unplaced: bool }`. `covers`/`intersects` (feeding `shared` and `contested`) read a claim with `unplaced == true` as whole-file; `hunks_of` (feeding `own_hunks`, the default election) returns only `placed`. `Anchor::Whole` (a `Write`, a claim, the anchor cap) still yields `Claim::Whole` — genuinely whole in both directions.

**Rationale:**
- Leaving some of my own work behind is a cheap, visible error (the row stays dirty and says so); taking the co-owner's work into my commit is the expensive, invisible one. The conservative direction for a claim is not the conservative direction for a landing (brief §F3).
- A `Write` really did produce the whole file — narrowing *that* election would be a lie in the other direction, which is why `Whole` (from evidence) and `unplaced` (from failure) must stay distinguishable.

**Implications:**
- `hunks_of` on `Claim::Hunks { placed, .. }` filters `placed` against current hunks; on `Claim::Whole` it still returns every hunk.
- **The narrowing is invisible when it narrows to empty.** An owner whose every anchor is unplaceable gets `own_hunks: []`, which `defaultElection` reads as whole-file, and the landing stages the file whole — today's behavior, now the floor instead of the norm. This decision therefore improves the *mixed* case (some anchors placed) and leaves the all-unplaceable case exactly where it was; see #non-goals for why closing it needs a wire change, and #roadmap for the follow-on.
- `changes.rs::paths_contend` reads only `.shared` (widened) — behavior unchanged there by construction.
- `contested` stays computed via the widened `covers`; `changeset.rs` already intersects it with `own_hunks` per file.
- The `contention.rs` module doc's "every uncertainty widens ([P12])" paragraph must be rewritten to state the split directions.

#### [P05] Legacy anchor rows keep legacy matching, unchanged (DECIDED) {#p05-legacy-unchanged}

**Decision:** Rows whose anchor JSON carries `new_hash`/`new_head`/`new_len` decode to `Anchor::Content` and match via the existing `content_matches` (hash equality, else head containment + the existing length floor), byte-for-byte as today.

**Rationale:**
- Zero-risk compatibility: a legacy row can at worst reproduce today's failure, never a new false placement (resolves [Q01]).
- The population self-drains via the row-liveness cut (Risk R03).

**Implications:**
- `Anchor::Content` and `content_matches` survive; only their all-or-nothing consumer changes (per [P03]/[P04]).
- `Anchor::from_span` tries the new shape first (`line_hashes` present), then the legacy shape, then `Whole`.

#### [P06] The added-lines text is a matcher input, not a diagnostic (DECIDED) {#p06-containment-fallback}

**Decision:** `added_head` (the anchor's added lines, joined and capped at `SPAN_HEAD_CAP`) is a second matching rule, not a comment. When **no** hunk matches an `AddedLines` anchor by line hash, a hunk matches if its `added_text` *contains* one of the anchor's distinctive added-line strings recoverable from `added_head`. Hash matching is tried first and, when it hits, the fallback never runs.

**Rationale:**
- Exact per-line hashing cannot reach two real cases: a **sub-line fragment** edit (`old_string`/`new_string` both mid-line, so the anchor's "line" is a fragment of the hunk's line and hashes differently), and a line past `ANCHOR_LINE_HASH_CAP`. The live ledger says ~10% of `replace` anchors are single-line (see #live-ledger-shape) — all line-aligned in the sample, so this is hardening rather than a load-bearing path, but it is nearly free.
- Storing 200 bytes of head and never reading it is the wrong trade in either direction: either spend the bytes and use them, or do not spend them.
- This is the **old C1 containment rule applied to correct input**. It failed before because the head carried unchanged context; over added-lines-only text, containment is sound. The distinguishing fact is what the head is *of*, not that containment was ever the wrong idea.

**Implications:**
- `added_head` is capped text, so the fallback is best-effort by construction — it is a fallback, and failing it just marks the anchor unplaced.
- The fallback obeys the same distinctiveness rule ([P03]): a fragment with no alphanumeric character is never used as a containment probe.
- No length floor is reintroduced anywhere. C2 stays dead — nothing in the new path compares the anchor's byte length against the hunk's.

---

### Deep Dives {#deep-dives}

#### Current end-to-end flow, and exactly where it bends {#current-flow}

1. **Record:** tugcast sees a `tool_use` frame; `spans_for_tool_input` (`tugcast/src/feeds/attribution.rs`) builds `FileEventSpan { kind: "replace"|"insert", anchor: json }` per edit; `PendingCall` carries them; the successful `tool_result` writes row + spans to the session ledger. *Bends here: the anchor JSON body changes shape ([P01]); nothing else in the record path moves.*
2. **Read (async feed):** `compose_snapshot` (`tugcast/src/feeds/changeset.rs`) finds paths with ≥2 proof owners, `contention_verdict` loads spans via `file_event_spans_for_paths`, decodes with `Anchor::from_span`, diffs the file, calls `classify_contention`, then per owner sets `file.shared`, `file.own_hunks = verdict.hunks_of(id, hunks)`, `file.contested_hunks = contested ∩ own_hunks`. *Bends here: only inside `classify_contention`/`hunks_of`; the caller is untouched.*
3. **Read (sync engine):** `paths_contend` (`tugchanges-core/src/changes.rs`) does the same dance and keeps only `.shared`. *Untouched by construction.*
4. **Deck:** `ChangesetFile.own_hunks` reaches `tugdeck/src/lib/hunk-election.ts::defaultElection`, which renders the `N of M hunks` badge iff `own_hunks` is a non-empty strict subset of current hunk ids; `ChangesRouteController.commit` sends `election[path] ?? own[path]` as the `hunks` map to `changeset_commit`, which routes any path with hunks through `stage_partial_and_commit` (`tugchanges-core/src/commit.rs`). *Untouched — the fix is entirely in what `own_hunks` contains.*

#### What the live ledger actually holds {#live-ledger-shape}

Measured on 2026-08-12 against the machine-global `changes.db` (via `just db-inspect changes "<SQL>"`, which copies the db + WAL before reading — never point `sqlite3` at the live file). Reproduce with `SELECT kind, count(*) FROM file_event_spans GROUP BY kind`.

| span kind | rows |
|---|---|
| `replace` | 759 |
| `hunk` | 162 |
| `whole` | 54 |

Of the 759 `replace` anchors, **685 (90%) are multi-line** and **74 (10%) are single-line** (classified by whether the JSON `new_head` contains an escaped newline). Every anchor sampled from both groups is **line-aligned**: it carries full leading indentation and complete lines — e.g. `"    let shell_dispatch_sessions = Some(Arc::clone(&ledger));"` and `"} from \"@/lib/layout-imposer\";"`. This is what licenses [P01]'s per-line hashing as the primary rule and demotes [P06]'s containment fallback to hardening.

C1 is directly visible in the raw rows. One real anchor reads:

```
"new_head":"  getLayoutRole,\n  isSidebarCard,\n  getGreedRank,\n  DEFAULT_GREED_RANK,\n  _resetForTest,","new_len":88
```

A five-line import list in which at most two lines are new and the rest are context the Edit carried for uniqueness. Today that anchor's hash matches nothing and its head is not contained in any hunk's added text, so its owner widens to the whole file. Under [P01] it reduces to the two added lines and places exactly.

#### Why multiset subtraction and not an LCS diff {#why-multiset}

An LCS/Myers line diff of `old_string → new_string` would reproduce git's added set more faithfully, but faithfulness in the *over*-approximating direction is the dangerous one: any line we record as added that git renders as context re-creates C1. Multiset subtraction (each line of `new_string`, minus one occurrence per matching line of `old_string`) can only drop moved-duplicate lines from the anchor — thinner evidence, same correctness. It is also order-insensitive and a dozen lines of code with no dependency. The matcher's any-line rule ([P03]) is what makes thin evidence sufficient: one surviving distinctive line places the edit.

#### Hunk-side line hashes {#hunk-side-hashes}

`classify_contention` currently precomputes `added: Vec<(id, added_text)>`. It grows a per-hunk `BTreeSet<String>` of `content_hash(line)` for each added line (no distinctiveness filter on the hunk side — the anchor side already filtered, and a filtered hunk set could only lose matches). `added_text` stays, because legacy `content_matches` still consumes it.

---

### Specification {#specification}

**Spec S01: Anchor JSON shapes** {#s01-anchor-json}

Written under span kinds `replace` (Edit with non-empty `old_string`) and `insert` (empty/absent `old_string`). The rows live in `changes.file_event_spans` in the **machine-global `changes.db`** — created by `tugcast/src/session_ledger.rs`, read by both `file_event_spans_for_paths` (async) and `tugchanges_core::ledger::spans_for_path` (sync); the per-instance `sessions.db` has no such table. The `anchor` column is `TEXT` and only its JSON *content* changes here, so there is **no DDL change and no `CHANGES_SCHEMA_VERSION` bump** — the rule in CLAUDE.md binds DDL edits, and this is not one.

New shape (written from this plan on):

```json
{
  "line_hashes": ["9f2c…", "b41a…"],
  "added_lines": 2,
  "added_head": "            size={12}"
}
```

- `line_hashes` — `content_hash` (first-16-hex of SHA-256, the one rule from `hunks.rs`) of each **distinctive** added line, in order, capped at `ANCHOR_LINE_HASH_CAP = 32` entries. *Distinctive* ([P03]): `let t = line.trim();` qualifies when `t.len() >= ANCHOR_MIN_LINE_BYTES` (= 3) **and** `t.chars().any(char::is_alphanumeric)`. A bare length floor is insufficient — `});` is 3 bytes.
- `added_lines` — total added-line count *before* the distinctiveness filter and cap. Diagnostics only; the matcher does not read it.
- `added_head` — the added lines joined with `\n`, truncated to `SPAN_HEAD_CAP` (200) bytes on a char boundary. **A matcher input** ([P06]): the containment fallback splits it back on `\n`, drops the trailing element when truncation may have severed it (i.e. whenever the joined text exceeded the cap), and probes with the distinctive survivors.
- An edit whose added set is empty or wholly indistinctive writes `"line_hashes": []` and its `added_head` — a valid span that places nothing.
- `old_hash` is no longer written.

Size note: at 32 hashes an anchor is roughly 800 bytes against ~250 today, and a `MultiEdit` at `SPANS_PER_EVENT_CAP` (32 edits) can write ~26KB of spans for one event row. The cap is 32 rather than 64 for exactly this reason; a 32-line edit that places on none of its first 32 distinctive lines is not a case worth another 800 bytes on every row.

Legacy shape (still decoded forever, per [P05]): `{"new_hash": …, "new_head": …, "new_len": …, "old_hash"?: …}`.

Decode order in `Anchor::from_span` for `insert`/`replace`: `line_hashes` present → `Anchor::AddedLines`; else `new_hash` + `new_head` present → `Anchor::Content`; else `Anchor::Whole`.

**Spec S02: Claim semantics** {#s02-claim-semantics}

| Evidence | Effect on claim | `shared`/`contested` reading | `hunks_of` (election) reading |
|---|---|---|---|
| No anchors at all | `Claim::Whole` | whole file | every current hunk |
| `Anchor::Whole` (Write / claim / cap) | `Claim::Whole` | whole file | every current hunk |
| `Anchor::Hunk` with live id | adds id to `placed` | that hunk | that hunk |
| `Anchor::Hunk` with drifted id | sets `unplaced = true` | whole file | not counted |
| `AddedLines`, ≥1 hunk matched by line hash | adds *all* matched ids to `placed` | those hunks | those hunks |
| `AddedLines`, no hash match but ≥1 containment match ([P06]) | adds all containment-matched ids to `placed` | those hunks | those hunks |
| `AddedLines`, zero matched by either rule (incl. empty `line_hashes`) | sets `unplaced = true` | whole file | not counted |
| Legacy `Content`, ≥1 hunk matched (`content_matches`) | adds all matched ids to `placed` | those hunks | those hunks |
| Legacy `Content`, zero matched | sets `unplaced = true` | whole file | not counted |

`Claim::covers(id)`: `Whole` → true; `Hunks { placed, unplaced }` → `placed.contains(id) || unplaced`. `Claim::intersects` treats `unplaced == true` as `Whole`. `ContentionVerdict::hunks_of`: `Whole` → all current hunks; `Hunks { placed, .. }` → current hunks filtered to `placed` (the `unplaced` flag is ignored here — that is the point of [P04]).

Matching predicate for `AddedLines`, in order — the second rule runs only when the first matched **no hunk at all**, never to widen a set the first rule already produced:

1. **Hash:** `anchor.line_hashes ∩ hunk.added_line_hashes ≠ ∅`.
2. **Containment ([P06]):** some distinctive probe line from `added_head` satisfies `hunk.added_text.contains(probe)`.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugchanges-core/src/anchors.rs` | Added-line derivation + anchor JSON construction, shared by relay and tests |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `edit_added_lines(old: &str, new: &str) -> Vec<String>` | fn | `anchors.rs` | Multiset subtraction, [P01] |
| `edit_anchor(old: Option<&str>, new: &str) -> serde_json::Value` | fn | `anchors.rs` | Builds Spec S01 new shape |
| `ANCHOR_LINE_HASH_CAP: usize = 32` | const | `anchors.rs` | Cap on `line_hashes` entries (size note, Spec S01) |
| `ANCHOR_MIN_LINE_BYTES: usize = 3` | const | `anchors.rs` | Length half of the distinctiveness rule, [P03] |
| `line_is_distinctive(line: &str) -> bool` | fn | `anchors.rs` | Length **and** alphanumeric, [P03]; shared by the constructor and [P06]'s probe filter |
| `containment_probes(added_head: &str, truncated: bool) -> Vec<&str>` | fn | `anchors.rs` | Splits `added_head`, drops a possibly-severed tail, keeps distinctive lines ([P06]) |
| `SPAN_HEAD_CAP: usize = 200` | const | move `attribution.rs` → `anchors.rs` | tugcast re-exports/uses from core |
| `head_excerpt(&str) -> &str` | fn | move `attribution.rs` → `anchors.rs` | char-boundary truncation |
| `Anchor::AddedLines { line_hashes: Vec<String>, added_lines: usize, added_head: String }` | enum variant | `contention.rs` | New decode target; `added_head` is a matcher input ([P06]) |
| `Anchor::from_span` | fn | `contention.rs` | New-shape-first decode order (Spec S01) |
| `Claim::Hunks { placed: BTreeSet<String>, unplaced: bool }` | enum variant | `contention.rs` | Replaces `Claim::Hunks(BTreeSet)`, [P04] |
| `claim_for` | fn | `contention.rs` | Accumulating, per Spec S02 |
| `classify_contention` | fn | `contention.rs` | Precompute per-hunk added-line hash sets (#hunk-side-hashes) |
| `ContentionVerdict::hunks_of` | fn | `contention.rs` | Placed-only for `Hunks`, [P04] |
| `edit_spans` | fn | `tugcast/src/feeds/attribution.rs` | Delegates to `edit_anchor` |
| `pub mod anchors` + re-exports | mod | `tugchanges-core/src/lib.rs` | |

---

### Documentation Plan {#documentation-plan}

- [ ] Rewrite `contention.rs`'s module-doc "The conservative direction" section to state the split directions ([P04]) — done as part of #step-2, listed here so the doc change is not read as optional.
- [ ] Module doc on `anchors.rs` stating the under-approximation contract (Risk R02) and why distinctiveness is alphanumeric-and-length, not length alone (Risk R01) — part of #step-1.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `anchors.rs` derivation edge cases; `contention.rs` placement over real-shaped anchors | C1/C2/C3 reproductions, F3 split and its limit, the distinctiveness rule, [P06] fallback |
| **Integration** | `compose_snapshot` over spans written by `spans_for_tool_input` | The F4 end-to-end gate in `tugcast/src/feeds/changeset.rs` |
| **Drift Prevention** | Existing `contention.rs`/`changeset.rs` tests updated to the new semantics | Multi-match no longer widens; unplaced narrows election |

The load-bearing convention change: contention fixtures for content anchors are built by calling `tugchanges_core::anchors::edit_anchor` (or, at the tugcast layer, `spans_for_tool_input`) on Edit-shaped `old_string`/`new_string` pairs *carrying unchanged context lines* — never by hashing the added text directly. The existing `content(text)` helper in `contention.rs` tests survives only where it deliberately models the legacy shape.

#### What stays out of tests {#test-non-goals}

- **Deck rendering of the badge** — `defaultElection` is already unit-covered and unchanged; no app-test is added (no frontend change to cover).
- **`stage_partial_and_commit` routing** — covered by existing `commit.rs` tests; this plan does not change routing (see #non-goals).
- **Live-ledger replay of the 400-row measurement** — neither the brief's methodology nor the census in #live-ledger-shape is reproducible in CI (both need the live `changes.db`); the structural causes are each pinned by a deterministic unit test instead, and the real anchor shapes those reads turned up are transcribed into fixtures.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | anchors module in tugchanges-core | done | `d107a8238` |
| #step-2 | contention: AddedLines matching + split widening | done | `9b08eb11b` |
| #step-3 | attribution: relay writes added-line anchors | done | `bc88fd4f4` |
| #step-4 | end-to-end regression gate over relay-shaped spans | done | `4d5b5b090` |
| #step-5 | Integration checkpoint | done | verification only |

#### Step 1: anchors module in tugchanges-core {#step-1}

**Commit:** `tugchanges-core(anchors): derive added-line anchors from edit inputs`

**References:** [P01] added-line anchors, [P02] shared constructor, [P03] distinctiveness rule, [P06] containment probes, Spec S01, Risk R01, Risk R02, (#why-multiset, #live-ledger-shape, #symbol-inventory)

**Artifacts:**
- `tugrust/crates/tugchanges-core/src/anchors.rs` with `edit_added_lines`, `edit_anchor`, `line_is_distinctive`, `containment_probes`, `ANCHOR_LINE_HASH_CAP`, `ANCHOR_MIN_LINE_BYTES`, `SPAN_HEAD_CAP`, `head_excerpt`.
- `pub mod anchors;` + re-exports in `tugrust/crates/tugchanges-core/src/lib.rs`.

**Tasks:**
- [ ] Implement `edit_added_lines(old, new)` as multiset subtraction over `lines()`: count each line of `old`, then emit each line of `new` whose remaining count is zero (decrementing otherwise). Order-preserving over `new`.
- [ ] Implement `line_is_distinctive(line)` per [P03]: trimmed length ≥ `ANCHOR_MIN_LINE_BYTES` **and** at least one `char::is_alphanumeric`. This is the single guard on Risk R01 — a length-only test would admit `});`.
- [ ] Implement `edit_anchor(old: Option<&str>, new: &str)`: added lines = `edit_added_lines(old.unwrap_or(""), new)`; `line_hashes` = `content_hash` of each line passing `line_is_distinctive`, capped at `ANCHOR_LINE_HASH_CAP` (32); `added_lines` = unfiltered count; `added_head` = `head_excerpt` of the added lines joined with `\n`. Returns the Spec S01 JSON value.
- [ ] Implement `containment_probes(added_head, truncated)` per [P06]: split on `\n`, drop the final element when `truncated` (the cap may have severed it mid-line), keep only `line_is_distinctive` survivors. `truncated` is `joined.len() > SPAN_HEAD_CAP` at the call site.
- [ ] Move `SPAN_HEAD_CAP` and `head_excerpt` here from `tugcast/src/feeds/attribution.rs` (leave attribution compiling by importing them — the relay swap itself is #step-3, but the constant move must not break tugcast in this commit; re-export from `attribution.rs` if its tests reference it, which they do).
- [ ] Module doc stating the under-approximation contract (Risk R02) and why distinctiveness is alphanumeric-and-length rather than length alone (Risk R01).

**Tests:**
- [ ] Context lines are excluded — the brief's real example: `old_string`/`new_string` differing only in the `size={12}` line, both carrying the `glyphPosition="both"` context line → `line_hashes` contains only the `size` line's hash, never `glyphPosition`'s.
- [ ] The ledger's real import-list shape (#live-ledger-shape): old/new sharing `getLayoutRole,` / `isSidebarCard,` / `_resetForTest,` with two lines added → exactly two hashes.
- [ ] Multiset semantics: a duplicated line added once more is recorded once.
- [ ] Distinctiveness: an edit adding only `});`, `};`, `}` and blank lines → `line_hashes: []` with `added_lines` > 0. Pin `});` by name — the 3-byte length floor alone would admit it.
- [ ] Short-but-real lines survive: `id,` and `use std::fmt;` are hashed.
- [ ] Cap behavior: > 32 distinctive added lines → 32 hashes, true `added_lines` count.
- [ ] `containment_probes` drops the severed tail when the joined text exceeded the cap, and keeps it when it did not.
- [ ] `head_excerpt` char-boundary truncation preserved (port the existing attribution test at its multi-byte `é` case).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`
- [ ] `cd tugrust && cargo build` (whole workspace still green — tugcast untouched behaviorally)

---

#### Step 2: contention — AddedLines matching + split widening {#step-2}

**Depends on:** #step-1

**Commit:** `tugchanges-core(contention): place anchors by added lines; badge widens, election narrows`

**References:** [P03] any-line multi-match, [P04] split widening, [P05] legacy unchanged, [P06] containment fallback, Spec S02, Risk R01, (#hunk-side-hashes, #s02-claim-semantics, #current-flow, #non-goals)

**Artifacts:**
- `Anchor::AddedLines`, restructured `Claim`, accumulating `claim_for`, narrowed `hunks_of` in `tugrust/crates/tugchanges-core/src/contention.rs`.

**Tasks:**
- [ ] Add `Anchor::AddedLines { line_hashes: Vec<String>, added_lines: usize, added_head: String }`; extend `Anchor::from_span` with the Spec S01 decode order (new shape first, legacy `Content` second, `Whole` last). `added_head` rides the variant because [P06] makes it a matcher input.
- [ ] Restructure `Claim::Hunks(BTreeSet<String>)` → `Claim::Hunks { placed: BTreeSet<String>, unplaced: bool }`; update `covers` (`placed.contains(id) || unplaced`) and `intersects` (`unplaced` reads as `Whole`).
- [ ] Rewrite `claim_for` per Spec S02: accumulate `placed` and `unplaced` across anchors; return `Claim::Whole` only for empty-anchor owners and `Anchor::Whole`. Legacy `Content` and `AddedLines` both claim *all* matched hunks; zero matches set `unplaced`.
- [ ] In `classify_contention`, precompute per-hunk `BTreeSet<String>` of added-line hashes alongside `added_text` (#hunk-side-hashes) — the hunk side hashes every added line unfiltered; `AddedLines` matches on non-empty intersection.
- [ ] Add [P06]'s fallback: when the hash rule matched **no hunk at all** for an `AddedLines` anchor, retry with `anchors::containment_probes(&added_head, …)` against each hunk's `added_text`. It never runs when the hash rule matched, so it can only turn an unplaced anchor into a placed one — never widen a set the hash rule already produced.
- [ ] Update `ContentionVerdict::hunks_of`: `Hunks { placed, .. }` → current hunks filtered to `placed`.
- [ ] Rewrite the module doc's "The conservative direction" section to state the split: shared/contested widen on uncertainty, the election carries only placed hunks; `Whole`-by-evidence still elects everything.
- [ ] Update existing tests to the new semantics: `an_ambiguous_anchor_widens_its_owner` becomes "an ambiguous anchor claims both hunks" (and both are contested when a co-owner claims one); `an_anchor_matching_nothing_widens_its_owner` asserts `shared == true` *and* empty `hunks_of`; `a_hunk_anchor_matches_by_id_and_widens_when_it_drifts` asserts drift → shared-widening with placed-only election.

**Tests:**
- [ ] **C1 gate:** anchor built via `anchors::edit_anchor` from old/new strings carrying unchanged context (the brief's `glyphPosition`/`size={12}` example) places into the one hunk whose added text is the changed line.
- [ ] **C2 gate:** a >1KB `new_string` rewriting one ~60-byte line places into that line's hunk.
- [ ] **C3 gate:** one edit whose added lines land in two hunks (import + call site fixture over `parse_hunks` of a two-hunk diff) claims both hunks; with a co-owner in one of them, only that hunk is contested.
- [ ] **F3 gate:** owner with one placing anchor + one unplaceable anchor vs a co-owner: `shared == true`, `hunks_of` returns only the placed hunk, contested covers the co-owner's hunk.
- [ ] **F3's limit, pinned:** an owner whose *every* anchor is unplaceable gets `shared == true` and **empty** `hunks_of` — the case #non-goals says this plan does not close. Asserting it keeps a later reader from mistaking the gap for a bug.
- [ ] **R01 gate:** an anchor whose only added line is `});` places nothing, marks unplaced, and does not claim a co-owner's hunk that also added `});`. Use `});` specifically, not `}` — `}` passes under any plausible rule, `});` is the one a length-only floor would have let through.
- [ ] **[P06] gate:** a sub-line fragment edit (`old_string` = `size={12}`, `new_string` = `size={14}`, no newlines) places into the hunk whose added line is `            size={14}` via containment, having matched nothing by hash.
- [ ] **[P06] does not widen:** an anchor that matched one hunk by hash does not additionally pick up a second hunk by containment.
- [ ] **Legacy gates:** old-shape JSON decodes to `Anchor::Content`; a legacy exact-hash anchor still places; a legacy no-match still widens `shared`.
- [ ] Decode: new-shape JSON → `AddedLines`; JSON with both shapes' fields prefers `AddedLines`; empty `line_hashes` array decodes as `AddedLines`, not `Whole`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`

---

#### Step 3: attribution — relay writes added-line anchors {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugcast(attribution): record Edit anchors as added lines`

**References:** [P01] added-line anchors, [P02] shared constructor, Spec S01, Risk R04, (#current-flow, #symbol-inventory, #r04-writer-before-decoder)

> **The decoder must land first.** This step is the *writer*; #step-2 is the reader. Committing them out of order (or building the app between them) means production writes anchors that `Anchor::from_span` decodes as `Whole`, silently widening every Edit-owner to a whole-file claim — the regression this plan exists to end. Hence the dependency below, and note that a stale `~/.local/bin/tugutil` symlinked at `main` can reproduce the same window until rebuilt (Risk R04).

**Artifacts:**
- `edit_spans` in `tugrust/crates/tugcast/src/feeds/attribution.rs` writing the Spec S01 shape via `tugchanges_core::anchors::edit_anchor`.

**Tasks:**
- [ ] Replace the anchor-body construction in `edit_spans` (hash/head/len of `new_string`, optional `old_hash`) with `edit_anchor(old_string_opt, new_string)`; keep the `replace`/`insert` kind rule (`old_string` non-empty → `replace`) and `SPANS_PER_EVENT_CAP` unchanged.
- [ ] Remove the now-local `head_excerpt`/`SPAN_HEAD_CAP` if step 1 left shims; import from `tugchanges_core::anchors`.
- [ ] Update `attribution.rs` unit tests that assert the old anchor fields (`new_hash`/`new_head`/`new_len`/`old_hash`) to assert the new shape: an Edit with context lines yields `line_hashes` for only the changed lines.

**Tests:**
- [ ] `spans_for_tool_input("Edit", …)` on an input whose `old_string`/`new_string` share context lines yields one `replace` span whose `line_hashes` exclude the context lines' hashes.
- [ ] `MultiEdit` yields one span per edit, each new-shape; > `SPANS_PER_EVENT_CAP` edits still collapse to the single `whole` span.
- [ ] An insert-kind input (`old_string` empty) records every distinctive line of `new_string`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 4: end-to-end regression gate over relay-shaped spans {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugcast(changeset): gate contention on relay-shaped Edit anchors`

**References:** [P03] any-line multi-match, [P04] split widening, Spec S01, Spec S02, (#success-criteria, #current-flow, #test-plan-concepts)

**Artifacts:**
- New tokio tests in `tugrust/crates/tugcast/src/feeds/changeset.rs` whose ledger spans come from `spans_for_tool_input` on Edit-shaped inputs — the F4 gate this feature never had.

**Tasks:**
- [ ] Add a compose test modeled on `compose_reads_disjoint_regions_of_one_file_as_uncontended`, but writing spans via `spans_for_tool_input("Edit", json!({"file_path": …, "old_string": …, "new_string": …}))` where both strings carry unchanged context lines around each session's edit. Assert: not shared, each owner's `own_hunks` is exactly its one hunk (strict subset — the badge shape `defaultElection` renders).
- [ ] Add a split-widening compose test: session A's spans place in one hunk plus one unplaceable anchor (an Edit whose text a later fixture write overwrote); session B places cleanly elsewhere. Assert: `shared == true` for both, A's `own_hunks` contains only its placed hunk.
- [ ] Update the existing `compose_reads_disjoint_regions_of_one_file_as_uncontended` / `compose_still_shares_a_file_two_sessions_edited_in_one_region` fixtures to *also* go through `spans_for_tool_input` instead of hand-minted anchor JSON, so no compose test keeps testifying for the unproducible shape.

**Tests:**
- [ ] The two new compose tests above.
- [ ] Existing compose suite green under the migrated fixtures.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P04] split widening, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full workspace verification; confirm no consumer of `Claim`/`ContentionVerdict` outside `contention.rs`, `changes.rs`, `changeset.rs` was missed (`grep -rn "Claim::Hunks\|hunks_of\|classify_contention" tugrust/crates`).
- [ ] Run the derived app-test selection for the working diff (Rust-side change; expect a small or empty selection — accept whatever `app-test-changed` derives).

**Tests:**
- [ ] Entire Rust workspace test suite.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Edit-shaped evidence places into hunks in the field: SHARED files carry a genuinely partial `own_hunks` (rendering the `N of M hunks` badge), and an unplaceable anchor widens the SHARED warning without widening what the session lands.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All C1/C2/C3 reproductions pass as unit tests with production-built anchors (`cargo nextest run -p tugchanges-core`).
- [ ] Compose tests over `spans_for_tool_input`-written spans yield strict-subset `own_hunks` (`cargo nextest run -p tugcast`).
- [ ] Legacy-shape anchors decode and behave per [P05] (unit tests).
- [ ] `cd tugrust && cargo nextest run` fully green; `just app-test-changed` selection green.

**Acceptance tests:**
- [ ] The brief's ledger example (`glyphPosition` context + `size={12}` change) places — the concrete field failure, now a pinned fixture.
- [ ] An import-plus-call-site edit claims both hunks without widening.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **A wire signal for "evidence that failed to place."** Today `own_hunks: []` means both "no contention data" and "we had evidence and none of it placed", and `defaultElection` reads both as whole-file — so the all-unplaceable owner still lands the co-owner's work (#non-goals, [P04]). A third state on `ChangesetFile` would let the row render "shared, regions unknown" and decline the whole-file default. This is the real end of the road this plan starts down, and it needs a protocol change plus a deck change.
- [ ] Content-matching fallback for drifted `hunk`-kind anchors (brief §"Out of scope"). Note [P06] now supplies the containment machinery this would reuse.
- [ ] Skip `stage_partial_and_commit` when a SHARED file's election covers every current hunk (brief §"Secondary consequence").
- [ ] Re-run the 400-row live-ledger replay after this ships to measure the field placement rate, against the baseline in #live-ledger-shape.

| Checkpoint | Verification |
|------------|--------------|
| Core placement fixed | `cargo nextest run -p tugchanges-core` |
| Relay shape fixed | `cargo nextest run -p tugcast` |
| Whole workspace | `cd tugrust && cargo nextest run` |
| App surface unaffected | `just app-test-changed` |
