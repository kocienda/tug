<!-- devise-skeleton v4 -->

## Dash Integration — Foundation {#dash-foundation}

**Purpose:** Give dashes a durable creation identity, a server-authoritative session↔dash binding, a machine-readable `dash status` readout, and a single shared implementation of dash-entry composition — the Rust/CLI substrate the visible dash UI (Changes lane, Lens section, join mode) stands on. Nothing in this phase renders; the phase ships when the wire and the ledgers carry the new facts.

This is Phase 1 of the program plan [dash/dash-integration-plan.md](dash-integration-plan.md). That plan's ratified decisions ([P01] overlay binding, [P02] many-cards-one-dash, [P03] dash creation id, [P06] derive-don't-record) are inherited here and cited as `program-[P##]` — they are settled and not reopened.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (run as a dash) |
| Last updated | 2026-08-13 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus (post-implementation audit).** Reviewed after the merge rather than before it: the review gesture this record is a product of did not exist when this plan was devised, so the assessment is of the shipped tree (`a4477d50b`) against the plan, not of the plan against the code. Lint: 0 errors, 0 warnings.

Applied: nothing. The implementation is faithful and the mechanisms hold up under the technical-choices and holes axes. Three specifics worth recording because they are what the phase was really for. The sessions-ledger migration is additive, column-checked, and self-healing in the same shape as its six predecessors, so a rollback leaves no wreckage. `mark_closed` clears `dash_id`/`dash_name` in the same UPDATE that closes the row, which is what makes *parked* reachable at all rather than a state the system can only claim. And `bound_sessions_by_dash` filters on `state = 'live'`, so a binding row that escaped the release is harmless instead of wrong — bound-ness is defined by that query, not merely reported by it. Wire additions are all `Option`/`skip_serializing_if` with an explicit legacy-decode test, so a deck and a server that disagree on version still talk.

Deferred: nothing raised.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Dashes today have no identity beyond a reusable branch name, no relationship to the sessions that work on them, and no single machine-readable answer to "where is this dash in its lifecycle?". Concretely: dash names are reusable and every artifact keys by name — which is why the `dash-join` skill must remember to `tugutil draft clear` after a land, or the *next* dash of the same name inherits a dead dash's clobber-protected join draft. No code anywhere links a session card to the dash it is working on; ownership is positional (which branch is checked out in the cwd, `tugutil/src/draft.rs::resolve_owner`) and per-commit (the `Tug-Dash` trailer, after the fact). And tugcast's changeset feed derives dash entries with logic explicitly flagged as duplicated from the CLI (`feeds/changeset.rs::dash_entries`: "Duplicated from the tug CLI until the dash core extracts into a shared crate").

This phase fixes the substrate: a **dash id** minted at create ([program-P03]), a **binding column** on the per-instance sessions ledger with CONTROL verbs and CLI verbs to set it ([program-P01], [program-P02]), a **`dash status`** verb, and the **`dash_entries` extraction** into tugdash-core with additive snapshot fields (`branch`, `stage`, `bound_sessions`) over an `owner_id` that now carries the id, so Phase 2 can render what this phase records.

#### Strategy {#strategy}

- Identity first: the dash id lands in tugdash-core before anything keys by it.
- Reuse the established compat patterns verbatim: draft rows migrate name→id keys via the same read-primary-then-fallback + supersede-on-write pattern `tugutil/src/draft.rs` already uses for the canonical/legacy path-spelling split; the sessions column lands via the `migrate_sessions_add_*` ALTER-TABLE idiom in `tugcast/src/session_ledger.rs`.
- One writer surface: CLI binding writes go through a new `POST /api/dash` on the running tugcast, mirroring `POST /api/draft` exactly (`tugutil/src/draft.rs::post_draft_api`, server handler `tugcast/src/server.rs::draft_handler`) — a short-lived CLI never opens an instance's `sessions.db` read-write.
- Reads tolerate what writes may miss: a binding whose dash no longer exists reads as unbound; a dash without a `tugid` reads under its legacy branch-ref identity. No hard cuts, no flag days.
- **The identity is resolved before it can be destroyed.** `git branch -D` deletes the branch's whole config section, `tugid` included — so every landing path (`join_in`, `release_in`, and their tugcast and CLI callers) resolves the owner key *before* the destructive call and carries it through the cleanup that follows. This is the [L23] hazard of the phase and the rule that retires it (see (#tuglaws), [P05]).
- Extraction pays the duplication debt at the moment the duplicated code would otherwise grow (the new fields), per the flag already in `feeds/changeset.rs`.
- Deck changes are plumbing only — types, guards, binding-store fields — so Phase 2 starts with the data already flowing. No rendering.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash create x --json` emits an `id`; a second `create x` (idempotent path) emits the same id. (Rust integration test.)
- `tugutil draft set --owner dash:x` writes a row whose `owner_id` is the id-qualified form; `tugutil dash join x` (fixture repo) uses that draft as its squash message; a pre-existing legacy `tugdash/x` row is still found when no id-keyed row exists **and is gone after the write** (the supersede lands through `POST /api/draft`, not only on the `TUG_CHANGES_DB` path). (Rust tests on both sides of the fallback, one of them through the server handler.)
- `bind_dash`/`unbind_dash` CONTROL round-trip: bind → `list_card_bindings_ok` rows carry `dash_id`/`dash_name` → unbind → they are null. (tugcast supervisor test.)
- A join or release through `do_changeset_join`/`do_changeset_release` clears every binding **and** the id-keyed draft row for that dash id — verified after the branch (and with it the `tugid` config) is gone. (tugcast test; the [L23] pin, see (#tuglaws).)
- A session that reaches `Closed` releases its binding: the dash reports zero `bound_sessions` and is therefore *parked*. (tugcast ledger test; the [L27] pin.)
- `tugutil dash status x --json` reports id, stage, base, rounds, worktree dirt, draft presence, and join-journal phase against a fixture repo. (Rust integration test.)
- `compose_snapshot` dash entries carry `branch`, `stage`, and `bound_sessions`, their `owner_id` is the owner key, and the composition comes from tugdash-core (the `feeds/changeset.rs` duplicate is deleted). (Rust test extending `compose_derives_dash_entries_from_tugdash_refs`.)
- The dash draft engine still generates for an id-keyed dash entry: `DraftTarget::Dash` resolves its git ref from the entry's `branch` field, and `gather_dash` produces a non-empty fingerprint + prompt. (tugcast test — the regression the `owner_id` flip would otherwise cause silently.)
- `cargo nextest run`, `bun test`, `bunx vite build`, and `just app-test-changed` all green at phase end.

#### Scope {#scope}

1. Dash creation id: minting, storage, exposure in every dash verb's output ([program-P03], Spec S01).
2. Draft rows for dashes keyed by id, with legacy-name fallback and supersede-on-write **on both writer surfaces** — the `TUG_CHANGES_DB` direct path and the production `POST /api/draft` path (Spec S02).
3. Session↔dash binding: sessions-table column, CONTROL verbs, `POST /api/dash`, CLI verbs, auto-bind on create, eager clear on tugcast join/release, release on session close, lazy tolerance everywhere (Spec S03, Spec S04).
4. `tugutil dash status` (Spec S05).
5. `dash_entries` extraction into tugdash-core + additive snapshot fields `branch`, `stage`, `bound_sessions` and the `owner_id` flip (Spec S06).
6. Deck plumbing: wire types + guards, `CardSessionBinding.dash`, spawn-ack/bindings decode. No rendering.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any visible UI — no Changes lane, no Lens section, no chrome chip, no `/dash` gesture (Phase 2).
- Step tracking (`dash step start|done`) and declared stage markers `built`/`audited` (Phase 3) — this phase's `stage` reports derived values only.
- Join mode, deck senders for `changeset_join`/`changeset_release` (Phase 4).
- Skill renames or skill-text rewrites (Phase 3).
- Cross-instance binding aggregation (see [Q02], deferred).

#### Dependencies / Prerequisites {#dependencies}

- The program plan's ratified decisions ([dash/dash-integration-plan.md](dash-integration-plan.md#ratified-decisions)).
- Existing machinery, all shipped: `tugdash-core/src/ops.rs` (create/list/show/join_in/release_in, `dash_base`, `dash_draft_message`, `integrate_message`), `tugutil/src/draft.rs` (`resolve_owner`, `parse_owner`, `post_draft_api`), `tugcast/src/server.rs` (`draft_handler`, loopback route registration), `tugcast/src/session_ledger.rs` (sessions DDL + `migrate_sessions_add_*` idiom), `tugcast/src/feeds/agent_supervisor.rs` (`handle_control`, `do_spawn_session` ack, `do_list_card_bindings`, `clear_dash_draft`, `do_changeset_join`, `do_changeset_release`), `tugcast/src/feeds/changeset.rs` (`compose_snapshot`, `dash_entries`), `tugcast-core/src/types.rs` (`ChangesetEntry::Dash`), `tugdeck/src/lib/changeset-types.ts`, `tugdeck/src/lib/card-session-binding-store.ts`.

#### Constraints {#constraints}

- Rust workspace `-D warnings`; `cargo nextest run` must stay green per step.
- `changes.db` schema is **not** touched — draft-row keying changes only the *values* in `owner_id`, never the DDL, so `CHANGES_SCHEMA_VERSION` stays at its current value. The per-instance `sessions.db` column lands via the tolerant `ALTER TABLE` idiom (no version gate exists or is needed there; see the comment block above the migration list in `session_ledger.rs`).
- Never open live ledger DBs with foreign sqlite3; tests use `TUG_CHANGES_DB` isolation and fixture repos, the established patterns in `tugutil/tests/` and tugcast's test modules.
- tugcast compose paths stay read-only on git: no config writes from `compose_snapshot` (see [P02]).
- Deck: no localStorage; changes must pass `bunx vite build`; wire-type changes are additive with guard updates and fixture updates.
- **Every path this phase persists or compares goes through the canonicalization gateway ([L29])** — `/api/dash` resolves `project_dir` with `path_resolver::resolve_to_claude_form`, exactly as `apply_draft_request` does, and the CLI ships its own spelling untouched. No canonicalize-both-sides shim anywhere.
- No new git subprocess fan-out on latency-critical paths: the restore round-trip (`do_list_card_bindings`, gated at `RESTORE_PASS_SETTLE_TIMEOUT_MS`) and per-recompute compose get **one** call each, never one per dash (see [P05], Spec S03).

#### Assumptions {#assumptions}

- Dash names cannot be renamed (no rename verb exists), so embedding the name in the id-qualified owner key is stable for a dash's lifetime.
- `sessions.db` is per-instance; a session's binding lives in exactly one instance's ledger, and the CLI can find that instance by trying each discovered port ([D09] discovery, `tugutil/src/commands/tell.rs` helpers).
- One dash per session at a time (a new bind replaces the old); many sessions may bind the same dash ([program-P02]). A binding is **live-session state**: only a session the ledger still calls live counts as bound, so a dash whose cards have all closed is *parked* ([P08], [L27]).
- The join journal (`<state-dir>/join-journal-<name>.json`, phases `Integrated|WorktreeRemoved|BranchDeleted`) is readable by tugdash-core for `status`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows devise-skeleton v4: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, `**Depends on:**` step anchors, `**References:**` on every step, no line-number citations. Program-plan decisions are cited as `program-[P##]`; global decisions as `[D##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Dash id format (DECIDED — see [P01]) {#q01-id-format}

**Question:** What string is the dash id, and what is the draft/binding key derived from it?

**Resolution:** DECIDED — see [P01]: `tugid = <unix-millis>-<6 lowercase hex>`, owner key `tugdash/<name>#<tugid>`.

#### [Q02] Cross-instance `bound_sessions` visibility (DEFERRED) {#q02-cross-instance}

**Question:** `compose_snapshot` reads the composing instance's `sessions.db`, so `bound_sessions` lists only *that instance's* bound sessions. Should the field aggregate across instances?

**Why it matters:** With two app instances on one checkout, each deck's Lens would show only its own instance's mated sessions for a shared dash.

**Resolution:** DEFERRED — per-instance visibility is correct for Phase 2's consumers (a deck shows its own cards; `cardIdForSession` only resolves local cards anyway). Revisit if a real cross-instance workflow surfaces; the wire field is a list, so aggregation is additive later.

#### [Q03] How does a CLI bind write reach the owning instance? (DECIDED — see [P04]) {#q03-cli-bind-route}

**Resolution:** DECIDED — `POST /api/dash` on each discovered instance until one accepts, mirroring `/api/draft`'s conduit doctrine with an ownership check. See [P04].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Legacy dash drafts stranded by the key change | med | med | read-fallback + supersede-on-write ([P03]) **on both writer surfaces**; test pins both directions | a join lands with the description instead of a written draft |
| Stale bindings after a CLI-side join/release (tugcast not in the loop) | med | med | lazy tolerance on read ([P05]) + best-effort `dash_gone` POST from the CLI | Lens (Phase 2) shows a mated session on a dead dash |
| The `owner_id` flip silently breaks dash draft generation | high | high without the fix | `branch` becomes an explicit entry field; `draft_engine` reads it instead of re-deriving from `owner_id` ([P09]); a test asserts a non-empty dash prompt for an id-keyed entry | an id-keyed dash stops producing a maintained draft |
| `ALTER TABLE sessions` collides with older builds sharing the file | low | low | per-instance db is single-build in practice; the `migrate_sessions_add_*` idiom already tolerates duplicate-column errors | migration warnings in logs |
| Extraction changes dash-entry composition behavior | med | low | port the existing `compose_derives_dash_entries_from_tugdash_refs` test unchanged before deleting the duplicate; keep the legacy-worktree fallback | fixture diff in the extraction step |
| `/api/dash` becomes an unauthenticated mutation surface | low | low | loopback-only route registration, exactly like `/api/draft`; ownership check before any write | — |

**Risk R01: id-less dashes (created by older builds) split identity** {#r01-idless-dashes}

- **Risk:** A dash created before this phase has no `tugid`; if read paths invented ids, two processes would mint different ones and drafts would fork.
- **Mitigation:** Only **write-path verbs** mint (`create`'s idempotent revisit, `bind`, `commit` — all funnel through `ensure_dash_id`, [P02]); every read path falls back to the legacy branch-ref identity when no id is on file. Minting is a git-config write in the repo, atomic enough at this concurrency (same-machine, same-user, advisory workflows).
- **Residual risk:** A read racing the first mint sees the legacy identity for one composition cycle — self-heals on the next bump.

**Risk R02: teardown destroys the identity its own cleanup needs ([L23])** {#r02-teardown-ordering}

- **Risk:** `git branch -D` removes the branch's entire config section, `tugid` included — verified, not assumed. Any cleanup that resolves the owner key *after* `join_in`/`release_in` returns therefore resolves the **legacy** key, matches zero id-keyed rows, and leaves the dash's binding rows and its authored draft row orphaned with nothing left in the system able to name them. That is the draft-haunting bug this phase exists to retire, resurrected in a form no `draft clear` can reach, and an [L23] violation: an internal operation destroying user-visible state.
- **Mitigation:** the owner key is resolved **before** the destructive call on every landing path and threaded through the cleanup ([P05]). Pinned by a test that asserts both the binding rows and the id-keyed draft row are gone *after* the branch is.
- **Residual risk:** a crash between the landing and the cleanup still strands rows; the lazy read tolerance ([P05]) makes them invisible rather than wrong, and the next `dash_gone` for that id sweeps them.

**Risk R03: a binding with no release ([L27])** {#r03-binding-release}

- **Risk:** sessions rows outlive their cards. A `dash_id` written at bind and never cleared on session close means a dash reports mated sessions forever — *parked* ([program-P02]) becomes unreachable, and Phase 2's Lens offers `focus-session-card` jumps to cards that no longer exist. [L27]: every acquisition returns its release, and the shorter-lived party (the session) calls it.
- **Mitigation:** [P08] — bound-ness is defined over **live** sessions, enforced in the one ledger query every consumer uses, and the session-close path clears the column outright.
- **Residual risk:** none material; a row that escapes the close path is still filtered out by the liveness predicate on read.

---

### Design Decisions {#design-decisions}

#### [P01] The dash id is `<unix-millis>-<6 hex>`, stored in branch config; the owner key is `tugdash/<name>#<tugid>` (DECIDED) {#p01-id-format}

**Decision:** `tugutil dash create` mints `tugid = <unix-millis>-<6 lowercase hex chars>` and stores it as `branch.tugdash/<name>.tugid`, beside the existing `tugbase` and `description` keys (`tugdash-core/src/ops.rs::create` writes those via `git config` today). The **owner key** — used for draft rows' `owner_id` and the sessions-table `dash_id` column — is `tugdash/<name>#<tugid>`. When no `tugid` is on file, the owner key degrades to the bare branch ref `tugdash/<name>` (the legacy identity, byte-identical to today's keys).

**Rationale:**
- Implements [program-P03]. The composite form keeps rows greppable by name while making each incarnation unique; the `#` separator cannot appear in a branch ref, so parsing is unambiguous and the legacy fallback is "everything before `#`".
- Storing in branch config follows the existing metadata home ([program-P06]: a dash IS git) and is torn down with the branch automatically.
- Millis+nonce needs no coordination and sorts chronologically for free.

**Implications:** `CreateOutcome`, `DashListItem`, `ShowOutcome` (`tugdash-core/src/ops.rs`) gain `id: Option<String>` (the full owner key); a shared `ensure_dash_id(repo, name) -> String` and read-only `dash_owner_key(repo, name) -> String` (key or legacy fallback) live beside `dash_base`.

#### [P02] Only write-path verbs mint ids; read paths fall back (DECIDED) {#p02-mint-on-write}

**Decision:** `ensure_dash_id` (mints when absent) is called from `create` (both the fresh and the idempotent-revisit paths), from the `/api/dash` bind handler, and from `commit`. All read paths — `list`, `show`, `status`, `dash_draft_message`, `integrate_message`, and tugcast's snapshot composition — use `dash_owner_key` (never mint).

**Rationale:** tugcast's `compose_snapshot` must stay read-only on git (a feed recompute that writes config is a side-effecting read and a multi-process race). Risk R01 covers the split-identity hazard this rule prevents.

**Implications:** an old dash first touched by a pure-read flow keeps its legacy identity until any write verb touches it — which is exactly the compat behavior the fallback readers already handle.

#### [P03] Dash draft rows migrate name→id by read-fallback + supersede-on-write (DECIDED) {#p03-draft-key-migration}

**Decision:** Dash draft rows in `changes.changeset_drafts` are keyed `owner_kind='dash', owner_id=<owner key per [P01]>`. Writers write the id-qualified key and delete any row under the legacy `tugdash/<name>` key for the same project (supersede). Readers query the id-qualified key first and fall back to the legacy key when it differs — layered on top of the existing canonical/raw `project_dir` spelling fallback, giving up to four probes worst-case.

**The supersede happens where the write happens.** Production draft writes go through `POST /api/draft`, and `apply_draft_request` sweeps siblings across *spellings of `project_dir`* under one `owner_id` — it has no notion of a second owner key. So the owner-key axis is added to the request the same way the spelling axis already is: `DraftApiRequest` gains `legacy_owner_id: Option<String>`, the exact mirror of `raw_project_dir`, and the handler uses it in all three places the spelling alternates are used — `read_existing`'s fallback, the supersede on `set`, and the sweep on `clear`. Without it the supersede would exist only on the `TUG_CHANGES_DB` test path and never in production, and a `draft set` carrying only a selection (`message: None`) against a legacy-keyed dash would fail with "nothing to set" because the server's read found nothing.

**Rationale:**
- This is byte-for-byte the pattern `tugutil/src/draft.rs::run_set` already uses for the path-spelling split ("A legacy-spelling row for the same owner is now stale — the row just written supersedes it") — one idiom, applied to a second axis.
- No DDL change, so `CHANGES_SCHEMA_VERSION` is untouched and older builds keep working (they read/write legacy keys, which newer readers still find).

**Implications:** touch points are exactly: `tugutil/src/draft.rs::parse_owner`/`resolve_owner` (resolve `dash:<name>` → owner key by reading the project's git config; keep legacy when unresolvable; both the direct-write and API bodies carry the legacy key alongside), `tugdash-core/src/ops.rs::dash_draft_message` (query id key then legacy, per spelling), tugcast `feeds/draft_engine.rs` (`DraftTarget::Dash` *keys* by the entry's `owner_id` but *resolves its git ref* from the entry's `branch` — see [P09]), `feeds/agent_supervisor.rs::clear_dash_draft` (delete under **both** keys, both spellings, with the key captured pre-teardown per [P05]), and `server.rs`'s `DraftApiRequest`/`apply_draft_request` (the `legacy_owner_id` axis above — **not** a pass-through).

#### [P04] CLI binding writes go through `POST /api/dash`, try-each-instance (DECIDED) {#p04-api-dash}

**Decision:** A new loopback-only `POST /api/dash` endpoint on tugcast handles `{op: "bind"|"unbind"|"dash_gone", ...}` (Spec S04). `tugutil dash bind|unbind` tries the cwd-derived instance first (`resolve_port`'s step 4 — `registry::find_for_cwd`, which already reaches through a dash worktree to its main checkout, so it is usually the owning instance on the first try) and falls back to walking **`tugcore::registry::list_live()`**, POSTing to each until one answers `ok`. An instance that does not own the session answers `unknown_session` and the CLI moves on. `dash_gone` (fired best-effort by CLI `join`/`release`) is broadcast to **every** live instance, since any of them may hold bindings to the dead dash.

`list_live()` is the enumeration primitive here, not the `resolve_port` family: `resolve_port_with` collapses the registry to a *single* port by design ([D09]), which is the right answer for a machine-global write and the wrong one for a per-instance ledger.

**`project_dir` on this endpoint obeys [L29].** The CLI sends its own spelling untouched; the handler resolves it through `path_resolver::resolve_to_claude_form` before it is used to open a repo or compared against anything persisted, exactly as `apply_draft_request` does. The CLI's `--project` defaults to cwd, so a `bind` issued from inside a dash worktree still names a real repo (branch config is shared with the main checkout).

**Rationale:**
- `sessions.db` is per-instance, so unlike `/api/draft` (whose target is machine-global and any instance is a valid conduit), a bind must land on the owning instance — try-until-owned is the minimal extension of the existing conduit doctrine.
- The HTTP route keeps the single-writer discipline: a short-lived CLI process never opens `sessions.db` read-write.
- Headless runs with no live instance degrade gracefully: bind fails with an actionable message (binding is a UI concept; a headless dash run loses nothing).

**Implications:** handler beside `draft_handler` in `tugcast/src/server.rs`, routed with the same loopback guard; the handler resolves the dash name → owner key via `ensure_dash_id` (bind is a write path, [P02]), writes the ledger, fires the changeset bump, and answers with the written binding.

#### [P05] Bindings clear eagerly on tugcast-side landings, lazily everywhere else (DECIDED) {#p05-binding-clear}

**Decision:** `do_changeset_join` and `do_changeset_release` (which already call `clear_dash_draft` on success) additionally clear every sessions-row binding and the id-keyed draft row matching the dash's owner key. CLI-side `tugutil dash join`/`release` POST `{op: "dash_gone", project_dir, dash_id}` to every live instance, best-effort (a warning on failure, never a join failure). Independently, **every read path treats a binding whose dash branch no longer exists as unbound** — `do_list_card_bindings` and the spawn ack null the fields when the branch is gone, and `compose_snapshot` never lists a bound session for a dash it isn't composing.

**Resolve-before-teardown is the load-bearing half.** `git branch -D` deletes `branch.tugdash/<name>.*` wholesale, so once `join_in`/`release_in` returns, `dash_owner_key` can only answer with the legacy key and every id-keyed row becomes unnameable (Risk R02, [L23]). Therefore:

- `do_changeset_join` / `do_changeset_release` capture `dash_owner_key(project_dir, name)` **before** the `spawn_blocking` call and pass it into `clear_dash_draft` and `clear_dash_bindings_for_dash`.
- `tugutil dash join` / `release` capture it before invoking the verb and send that captured value as `dash_gone`'s `dash_id`.
- `clear_dash_draft` takes an owner key, not a dash name — the name-to-key resolution it does today cannot survive its own caller's teardown.

`dash_gone` keys by `dash_id`, never by name: the column holds owner keys, and a name would either miss every row or demand a prefix match that would also sweep a *live* successor dash of the same name — the precise haunting this phase retires.

**Rationale:** the eager path covers the card workflow; the lazy path guarantees correctness when tugcast was never in the loop (terminal joins, crashes between teardown and POST). Tolerant reads are the same doctrine as [P02]'s fallback: no state is trusted to be perfectly maintained when two writers (CLI, server) share it.

**Implications:** the branch-existence check is **one** `git for-each-ref refs/heads/tugdash/` per repo, membership-tested in memory — not `rev-parse` per dash. `do_list_card_bindings` is the startup restore round-trip that holds cards on `SessionRestoring` behind `RESTORE_PASS_SETTLE_TIMEOUT_MS`, and `do_spawn_session` runs on every card spawn; neither may grow subprocess fan-out proportional to the dash count.

#### [P06] `stage` in this phase is derived-only (DECIDED) {#p06-derived-stage}

**Decision:** The `stage` field (Spec S05/S06) reports only what git and the ledgers can derive: `created` (no rounds, clean worktree), `working` (rounds > 0 or dirty worktree), `draft-ready` (non-empty maintained draft), `landing` (join journal present). Declared stages (`implementing (i/N)`, `built`, `audited`) arrive in Phase 3 with the step verbs; the wire fields for them (`step_current`, `step_total`) are declared optional now and stay absent.

**Rationale:** [program-P06] derive-don't-record; shipping the derived subset now gives Phase 2 an honest stage to render without inventing state Phase 3 owns.

#### [P07] Deck plumbing is types-and-stores only (DECIDED) {#p07-deck-plumbing}

**Decision:** The deck work in this phase is exactly: additive fields on `DashChangesetEntry` (`changeset-types.ts` + guards + fixtures), `CardSessionBinding` gaining `dash?: { id: string; name: string }` (`card-session-binding-store.ts`) with a **merge setter** for it, decode of the new fields on `protocol.ts`'s `CardBinding` and the `spawn_session_ok` ack path in `action-dispatch.ts`, and handling of the `bind_dash_ok` / `unbind_dash_ok` broadcasts. No component renders any of it.

**The restore path writes nothing.** `session-restore.ts` does not populate `cardSessionBindingStore` today and must not start: it matches `list_card_bindings_ok` rows to cards and *re-spawns*, and the resulting `spawn_session_ok` ack is what writes the binding — the store's contract is "populated from the spawn ack only", and the clear-then-restore ordering on reconnect depends on it ([D04] of the session-connection-health plan). The dash fields therefore ride `CardBinding` for completeness and reach the store the same way `workspaceKey` does. Adding a second writer would be a contract change bought for nothing.

**`bind_dash_ok` needs a merge, not a set.** `setBinding` replaces the whole record; a bind arriving mid-session must not clobber `workspaceKey`/`projectDir`. Hence `setDashBinding(cardId, dash | null)`, which merges into the existing entry and no-ops when the card has none.

**Rationale:** Phase 2 starts from flowing data instead of a protocol change; and keeping this phase invisible honors the program plan's phase boundary ("nothing visible").

#### [P08] Bound-ness is defined over live sessions, and closing a session releases its binding (DECIDED) {#p08-binding-liveness}

**Decision:** A binding counts only while the session is live. Two mechanisms, both required:

- **Release:** the session-close path clears `dash_id`/`dash_name` on the row, so the acquisition made at bind is returned by the party that made it ([L27]).
- **Filter:** `bound_sessions_by_dash()` — the single query every consumer uses (`dash status`, `compose_snapshot`, the Lens in Phase 2) — filters on session state, so a row that escapes the release path is still never reported.

**Rationale:** sessions rows outlive their cards by design (that is how restore works). Without this, a `dash_id` written once is reported forever: the *parked* state ([program-P02]: zero bound sessions, rounds exist) becomes unreachable, and Phase 2's Lens would offer `focus-session-card` jumps into cards that no longer exist. Defining bound-ness once, in the query, rather than at each call site is what keeps `status` and the feed from disagreeing. Risk R03.

**Implications:** `sessions_bound_to_dash(dash_id)` is **not** the shape to build — a per-dash accessor forces N queries per compose. The API is `bound_sessions_by_dash() -> HashMap<String, Vec<String>>`, one query returning every live binding, from which both the per-dash lookup and the feed's fan-out are served.

#### [P09] The dash entry carries its git ref explicitly (DECIDED) {#p09-branch-field}

**Decision:** `ChangesetEntry::Dash` gains `branch: String` (the ref, `tugdash/<name>`) as a first-class field. `owner_id` becomes the owner key and is the *identity* — draft rows, binding rows, and the `changeset_draft_state` overlay key. Every consumer that needs a **git ref** reads `branch`. The redundant `id` field the earlier draft of this plan proposed is dropped: it would have carried a string byte-identical to `owner_id`, and two fields holding one value drift.

**Rationale:** `draft_engine.rs` currently derives the ref by *assumption* — `let branch = owner_id.clone(); // The dash branch ref is the owner id` — and `gather_dash` then runs `rev-parse <branch>`, `log <base>..<branch>`, `fetch_dash_diff(…, branch)`, and `branch.strip_prefix("tugdash/")` for the dash-log read. Flipping `owner_id` under that assumption breaks all four *silently*: git returns empty, the fingerprint and prompt come out degenerate, and dash draft generation stops with no error anywhere. An explicit field converts an invisible runtime failure into a compile error at every call site.

The identity must be `owner_id` rather than a side field because the deck keys its draft overlays by `(workspace_key, owner_kind, owner_id)` taken from the entry (`changeset-draft-store.ts`), and the server's `changeset_draft_state` broadcasts carry the same `owner_id` — entry, row, and overlay have to agree on one string or the overlay silently never matches.

**Implications:** `feeds/changeset.rs::entry_sort_key` sorts dashes by `owner_id`; the order is unchanged because `#` (0x23) sorts below every character valid in a dash name, so `demo#…` still precedes `demo2#…`. That is a fact to pin with an assertion, not to leave as luck.

---

### Deep Dives {#deep-dives}

#### Current identity and draft flow (what changes, precisely) {#current-flow}

- **Create** (`tugdash-core/src/ops.rs::create`): `git worktree add <repo>/.tug/worktrees/<sanitized> -b tugdash/<name> <base>`, then writes `branch.tugdash/<name>.tugbase` and `.description` via `git config`, enables rerere, runs `[tugtool.dash].post_create` hooks with rollback. Idempotent path returns `created: false` without re-hydration — **both paths must surface the id** ([P01]); the idempotent path calls `ensure_dash_id` (a fully-present old dash gets its id on revisit, a write-path touch per [P02]).
- **Draft ownership today**: `tugutil/src/draft.rs::parse_owner` maps `dash:<name>` → `("dash", "tugdash/<name>")`; `resolve_owner`'s derivation (cwd on a `tugdash/*` branch) produces the same. `dash_draft_message` (`ops.rs`) reads `WHERE owner_kind='dash' AND owner_id=<branch> AND project_dir=<canonical|raw>`. `integrate_message` chains override → draft → description → `"Dash work"`.
- **Draft writes in production** go through `POST /api/draft` (`tugutil/src/draft.rs::post_draft_api` → `tugcast/src/server.rs::draft_handler`); the server is the [L29] canonicalization gateway for `project_dir`. Under `TUG_CHANGES_DB` (tests) the CLI writes the private db directly. The `owner_id` value passes through the server untouched — which is why [P03]'s key change needs no server-side draft work beyond `clear_dash_draft`.
- **Draft cleanup**: `feeds/agent_supervisor.rs::clear_dash_draft(ledger, project_dir, dash_name)` builds the branch-ref owner id and calls `ledger.delete_changeset_draft("dash", owner_id, key)` — one key, and only the `CanonicalPath::from_raw` spelling; called from `do_changeset_join` and `do_changeset_release` success paths, i.e. *after* the branch is gone. The test `releasing_or_joining_a_dash_clears_its_draft` pins it. Under [P03] this fn takes a pre-resolved owner key and deletes under both keys and both spellings ([P05], Risk R02).
- **Branch config dies with the branch**: `git branch -D tugdash/<name>` removes the whole `branch.tugdash/<name>.*` section — `tugbase`, `description`, and `tugid` alike. Verified directly, and the reason [P05]'s resolve-before-teardown rule exists. It is also why [P01] chose branch config as the id's home: nothing has to garbage-collect it.
- **Draft generation's ref assumption**: `feeds/draft_engine.rs` builds `DraftTarget::Dash` with `let branch = owner_id.clone()`; `gather_dash` uses that string as a git ref four times over and strips `tugdash/` from it for the dash-log read. [P09] replaces the assumption with the entry's `branch` field.
- **Round commits** (`ops.rs::commit`) append `Tug-Session`/`Tug-Session-Id`/`Tug-Dash` trailers via `with_dash_trailers`; `session_citation` reads the per-instance `sessions.db` resolved by `sessions_db_file()` — the same resolution `status` reuses for `bound_sessions` (best-effort, [Q02]).

#### Current binding flow (what the column plugs into) {#current-binding-flow}

- The sessions DDL (`tugcast/src/session_ledger.rs`, the `CREATE TABLE IF NOT EXISTS sessions` block) carries `session_id`, `workspace_key`, `project_dir`, `card_id`, `state`, naming/tag/synopsis fields. Column additions use the `migrate_sessions_add_*` functions called just above the DDL (e.g. `migrate_sessions_add_synopsis`) — tolerant `ALTER TABLE`, duplicate-column errors swallowed.
- **Spawn ack** (`feeds/agent_supervisor.rs::do_spawn_session`): reads the session's ledger row and emits `spawn_session_ok` with `card_id`, `tug_session_id`, `workspace_key`, `project_dir`, `session_mode`, `name`, `tag`, `synopsis`, `private`. The dash binding rides here as `dash_id` / `dash_name` (nullable), subject to [P05] tolerant reads.
- **Restore** (`do_list_card_bindings`): emits one JSON row per card-bound session (`card_id`, `session_id`, `project_dir`, `state`, `turn_count`, `is_alive`, `has_jsonl`, `name`, …). `dash_id`/`dash_name` join this row set the same way.
- **Deck**: `card-session-binding-store.ts` maps `cardId → CardSessionBinding{tugSessionId, workspaceKey, projectDir, sessionMode}`, populated from the spawn ack only (clear-then-restore on reconnect is contractual); `session-restore.ts` consumes `list_card_bindings_ok`.

#### The extraction target {#extraction-target}

`feeds/changeset.rs::dash_entries(repo_root)` re-implements: branch enumeration (`for-each-ref refs/heads/tugdash/`), base lookup (`branch.<branch>.tugbase`, defaulting `"main"` — note tugdash-core's `dash_base` instead falls back to `detect_default_branch`; the extraction adopts tugdash-core's richer fallback), round count, the worktree sanitizer + legacy `.tugtree/tugdash__<sanitized>` fallback (duplicating `ops.rs::worktree_path`), worktree dirt, `base...branch` name-status files, and newest-first `round_subjects`. The extraction moves this into a tugdash-core function taking an explicit `repo_root` (the crate's `list()` is cwd-relative; the new fn is the `_in` variant of it with per-entry detail), returning a serializable struct tugcast maps into `ChangesetEntry::Dash`. tugcast calls it via `tokio::task::spawn_blocking` (tugdash-core is sync; the supervisor already runs `join_in` on a blocking thread). The existing test `compose_derives_dash_entries_from_tugdash_refs` must pass unchanged against the extracted implementation before the duplicate is deleted.

---

### Specification {#specification}

**Spec S01: Dash id** {#s01-dash-id}

- Mint: `tugid = format!("{millis}-{nonce}")`, `millis` = unix epoch millis at mint, `nonce` = 6 lowercase hex chars from a thread-local RNG.
- Storage: `git config branch.tugdash/<name>.tugid <tugid>` in the base repo.
- Owner key: `tugdash/<name>#<tugid>`; legacy form `tugdash/<name>` when no `tugid` exists.
- API (tugdash-core, beside `dash_base`): `ensure_dash_id(repo: &Path, name: &str) -> Result<String, String>` (returns the owner key, minting if absent); `dash_owner_key(repo: &Path, name: &str) -> String` (read-only; legacy fallback); `legacy_owner_key(owner_key: &str) -> &str` (strips `#…`).
- Exposure: `id: Option<String>` (the owner key) on `CreateOutcome`, `DashListItem`, `ShowOutcome`, and the Spec S05 status output. On the Spec S06 wire entry the owner key travels as `owner_id` and there is no separate `id` field ([P09]).

**Spec S02: Dash draft row keying** {#s02-draft-keys}

- Write: `owner_id = dash_owner_key(...)`; after a successful id-keyed write, delete the legacy-keyed row for the same `(owner_kind, project_dir)` pair (both spellings).
- Read: probe `(id key, canonical) → (id key, raw) → (legacy key, canonical) → (legacy key, raw)`, first hit wins.
- Wire: `DraftApiRequest` gains `legacy_owner_id: Option<String>`, the mirror of `raw_project_dir`. `apply_draft_request` folds it into all three sibling operations — `read_existing`'s fallback, the `set` supersede, the `clear` sweep — so the owner-key axis and the spelling axis are handled by one mechanism. The CLI populates it on both writer paths.
- Applies to: `tugutil draft set|show|clear` (owner resolution in `resolve_owner`/`parse_owner`), `server.rs::apply_draft_request`, `dash_draft_message`, `draft_engine` generation targets (keyed by `owner_id`; ref from `branch`, [P09]), `clear_dash_draft` (takes a pre-resolved owner key, deletes under both keys, both spellings).

**Spec S03: Binding column + CONTROL verbs** {#s03-binding-control}

- Column: `migrate_sessions_add_dash_binding` adds `dash_id TEXT` and `dash_name TEXT` to `sessions` (name denormalized for display without a git read; `dash_id` is the owner key and the authority).
- Ledger API (`session_ledger.rs`): `set_dash_binding(session_id, Option<(dash_id, dash_name)>)`, `clear_dash_bindings_for_dash(dash_id) -> usize`, and `bound_sessions_by_dash() -> HashMap<String, Vec<String>>` — **one** query returning every *live* session's binding, per [P08]. There is deliberately no per-dash accessor: `status` looks its dash up in the map, compose fans the whole map out, and neither can drift from the other on what "bound" means.
- Release: the session-close path clears the columns ([P08], [L27]).
- CONTROL `bind_dash` payload `{tug_session_id, project_dir, dash}` → resolve owner key via `ensure_dash_id` in `project_dir`'s repo → `set_dash_binding` → changeset bump (the same aggregate bump `do_changeset_join` fires on a land) → broadcast `bind_dash_ok {tug_session_id, dash_id, dash_name}` / `bind_dash_err {reason}`.
- CONTROL `unbind_dash` payload `{tug_session_id}` → `set_dash_binding(.., None)` → bump → `unbind_dash_ok`.
- Dispatch: two new arms in `handle_control` beside `list_card_bindings`.
- Echo: `spawn_session_ok` and `list_card_bindings_ok` rows gain nullable `dash_id`, `dash_name`, nulled on read when the dash branch is gone ([P05]) — the liveness set comes from **one** `for-each-ref refs/heads/tugdash/` per repo, never a `rev-parse` per dash.

**Spec S04: `POST /api/dash`** {#s04-api-dash}

Request/response, loopback-only, registered beside `/api/draft`. Every `project_dir` is resolved through `path_resolver::resolve_to_claude_form` on arrival ([L29], [P04]) — the CLI ships its own spelling:

| op | body | behavior | response |
|---|---|---|---|
| `bind` | `{op, tug_session_id, project_dir, dash}` | ownership check (session in this ledger, else `unknown_session`); `ensure_dash_id`; `set_dash_binding`; bump | `{status:"ok", dash_id, dash_name}` |
| `unbind` | `{op, tug_session_id}` | ownership check; clear binding; bump | `{status:"ok"}` |
| `dash_gone` | `{op, project_dir, dash_id}` | `clear_dash_bindings_for_dash` + the id-keyed draft sweep; bump when any row cleared | `{status:"ok", cleared: n}` |

`dash_gone`'s `dash_id` is the owner key the caller captured **before** teardown ([P05]) — the endpoint never re-derives it, because by the time this call is made the branch config it would read is gone.

Errors: `{status:"error", message}` with `unknown_session` distinguishable so the CLI's try-each-instance loop can continue silently.

**Spec S05: `tugutil dash status <name> --json`** {#s05-dash-status}

New `DashCommands::Status` variant; `ops::status_in(repo_root, name) -> DashStatus`:

```json
{"ok": true, "verb": "dash status", "data": {
  "name": "…", "id": "tugdash/…#…", "branch": "tugdash/…", "base_branch": "…",
  "stage": "created|working|draft-ready|landing",
  "rounds": 3, "worktree": "…", "worktree_dirty": false,
  "draft": true, "join_journal_phase": null,
  "bound_sessions": ["<session-id>", …],
  "step_current": null, "step_total": null
}}
```

`stage` per [P06]; `bound_sessions` best-effort from `sessions_db_file()` read-only, **live sessions only** per [P08] (empty when unresolvable, when the column has not been migrated in yet, or when every bound card has closed — an empty list is how *parked* reads); `step_*` reserved for Phase 3. Plain (non-`--json`) output: one human-readable block per the CLI's existing no-glue doctrine.

**Spec S06: Snapshot additions** {#s06-snapshot-additions}

`ChangesetEntry::Dash` (`tugcast-core/src/types.rs`) and `DashChangesetEntry` (`tugdeck/src/lib/changeset-types.ts`) gain, additively: `branch?: string` (the git ref — [P09]), `stage?: string`, `bound_sessions?: string[]`, `step_current?: number`, `step_total?: number`. There is no `id` field: **`owner_id` flips to the owner key** (id-qualified when the dash has an id, legacy branch ref otherwise) and *is* the id. The deck treats `owner_id` as an opaque identity (display uses `display_name`, refs use `branch`), and the draft attached to the entry is looked up under the same key, so entry, draft row, and the deck's `(workspace_key, owner_kind, owner_id)` overlay key stay consistent by construction.

Consumers that must move with the flip, none of them optional:

- `feeds/draft_engine.rs` — `DraftTarget::Dash.branch` comes from the entry's `branch` field, not `owner_id.clone()` ([P09]).
- `feeds/changeset.rs::entry_sort_key` — unchanged in behavior; assert the ordering rather than assume it ([P09]).
- Rust golden snapshot fixtures; `tugdeck/src/lib/__tests__/changes-route-controller.test.ts`, which asserts `owner_id === "tugdash/fix-join"`; and `changeset-types.ts`'s doc comment, which currently *defines* `owner_id` as the branch ref.

ts guards accept old and new shapes.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `CardSessionBinding.dash` | external | existing `cardSessionBindingStore` + `useSyncExternalStore`; field addition plus a merge setter, one writer (the ack path) | [L02] |
| Dash entry fields (`branch`/`stage`/`bound_sessions`) | server | ride the CHANGESET_ALL snapshot; no new store | [L02] |

#### Tuglaws Adherence {#tuglaws}

Each law this phase touches, the hazard it names here, and the mechanism that retires it. The last column is the test that keeps it retired — a law with no pin is a rule the next change can break silently.

| Law | Hazard in this phase | Retired by | Pinned by |
|---|---|---|---|
| [L23] — internal operations must never destroy user-visible state | `git branch -D` deletes `tugid` with the branch; cleanup that resolves the owner key afterwards orphans the user's authored join draft under a key nothing can name again (Risk R02) | resolve-before-teardown on every landing path; `clear_dash_draft` takes a pre-resolved key ([P05]) | #step-3 test: join, then assert the id-keyed draft row and the binding rows are gone **after** the branch is |
| [L27] — every acquisition returns its release | a `dash_id` written at bind and never cleared reports mated sessions forever; *parked* becomes unreachable, Phase 2 jumps to dead cards (Risk R03) | session-close clears the columns; bound-ness filtered on liveness in the one shared query ([P08]) | #step-3 test: close a bound session → dash reports zero `bound_sessions` |
| [L29] — every persisted or compared path routes through the gateway | `/api/dash` accepts a CLI-spelled `project_dir` | handler resolves with `resolve_to_claude_form` before use, as `apply_draft_request` does; CLI never canonicalizes ([P04]) | #step-3 test: bind with a non-canonical spelling resolves to the same session row as the canonical one |
| [L02] — external state enters React through `useSyncExternalStore` only | a new binding field could tempt a component-level cache | field lands on the existing store, read through the existing hook; no new store, no component state ([P07]) | #step-7 bun test: binding decode round-trip; `bunx vite build` |
| [LR8] — one ledger writer | a short-lived CLI writing `sessions.db` | all CLI binding writes go through `POST /api/dash` ([P04]) | #step-4 test: the CLI's only ledger path is the HTTP handler |

`compose_snapshot` staying read-only on git ([P02]) is the same discipline applied to a feed rather than a law entry: a recompute that wrote config would be a side-effecting read and a multi-process race.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/dash_api.rs` | `POST /api/dash` handler (Spec S04), mirroring `server.rs::draft_handler`'s structure |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ensure_dash_id`, `dash_owner_key`, `legacy_owner_key` | fn | `tugdash-core/src/ops.rs` | Spec S01, [P01]/[P02] |
| `CreateOutcome.id`, `DashListItem.id`, `ShowOutcome.id` | field | `tugdash-core/src/ops.rs` | Spec S01 |
| `dash_draft_message` | fn (modify) | `tugdash-core/src/ops.rs` | four-probe read, Spec S02 |
| `status_in`, `DashStatus` | fn/struct | `tugdash-core/src/ops.rs` | Spec S05, [P06] |
| `dash_detail_entries_in(repo_root)` | fn | `tugdash-core/src/ops.rs` | the extraction (#extraction-target) |
| `parse_owner` / `resolve_owner` | fn (modify) | `tugutil/src/draft.rs` | `dash:<name>` → owner key via git config, legacy fallback; both bodies carry `legacy_owner_id` |
| `DraftApiRequest.legacy_owner_id` + sibling handling | field/fn (modify) | `tugcast/src/server.rs` (`apply_draft_request`) | Spec S02, [P03] — the production supersede |
| `DashCommands::{Status, Bind, Unbind}` | enum variants | `tugutil/src/cli.rs` | + dispatch in `tugutil/src/dash.rs` |
| `post_dash_api` (cwd instance, then `registry::list_live()`) | fn | `tugutil/src/dash.rs` | [P04] |
| auto-bind after create; pre-teardown key capture + `dash_gone` after join/release | glue | `tugutil/src/dash.rs` | best-effort, warn-never-fail; [P05] ordering |
| `migrate_sessions_add_dash_binding` | fn | `tugcast/src/session_ledger.rs` | Spec S03 |
| `set_dash_binding`, `clear_dash_bindings_for_dash`, `bound_sessions_by_dash` | fn | `tugcast/src/session_ledger.rs` | Spec S03, [P08] — one query, live only |
| binding release on session close | modify | `tugcast/src/session_ledger.rs` | [P08], [L27] |
| `bind_dash` / `unbind_dash` arms | match arms | `tugcast/src/feeds/agent_supervisor.rs::handle_control` | Spec S03 |
| `do_spawn_session` ack + `do_list_card_bindings` rows | modify | `tugcast/src/feeds/agent_supervisor.rs` | `dash_id`/`dash_name`, [P05] tolerant read via one `for-each-ref` |
| `clear_dash_draft` | fn (modify) | `tugcast/src/feeds/agent_supervisor.rs` | takes a pre-resolved owner key; deletes both keys, both spellings — Spec S02, [P05] |
| binding + draft clear in `do_changeset_join`/`do_changeset_release` | modify | `tugcast/src/feeds/agent_supervisor.rs` | [P05]; key captured **before** `spawn_blocking` |
| `dash_entries` | delete | `tugcast/src/feeds/changeset.rs` | replaced by tugdash-core call via `spawn_blocking` |
| `entry_sort_key` ordering assertion | test | `tugcast/src/feeds/changeset.rs` | [P09] |
| `ChangesetEntry::Dash` new fields (incl. `branch`) | fields | `tugcast-core/src/types.rs` | Spec S06, [P09] |
| `DraftTarget::Dash` ref source | modify | `tugcast/src/feeds/draft_engine.rs` | [P09] — from `branch`, not `owner_id` |
| `DashChangesetEntry` new fields + guards | type | `tugdeck/src/lib/changeset-types.ts` | Spec S06, [P07]; doc comment on `owner_id` moves to `branch` |
| `CardSessionBinding.dash` + `setDashBinding` merge setter | field/fn | `tugdeck/src/lib/card-session-binding-store.ts` | [P07]; written from the spawn-ack path and `bind_dash_ok` only |
| `CardBinding` dash fields | type | `tugdeck/src/lib/protocol.ts` | [P07]; decode only — `session-restore.ts` writes no bindings |

---

### Documentation Plan {#documentation-plan}

- [ ] Rustdoc on the new tugdash-core fns states the identity model ([P01]), the mint-on-write rule ([P02]), and — on `dash_owner_key` — that the key must be read **before** any teardown, because `git branch -D` takes the config with it ([P05], Risk R02).
- [ ] Rustdoc on `clear_dash_draft` / `clear_dash_bindings_for_dash` states that they take a pre-resolved owner key and why they cannot resolve one themselves.
- [ ] `tugutil dash --help` text for `status`/`bind`/`unbind`.
- [ ] The tuglaws doc (`dash-lifecycle.md`) is **Phase 5**; no laws edits here.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | id mint/parse/fallback; stage derivation; four-probe draft read | steps 1, 2, 5 |
| **Integration (Rust)** | CLI round-trips against fixture repos under `TUG_CHANGES_DB`; supervisor CONTROL round-trips; join-uses-id-keyed-draft | steps 2–6 |
| **Golden / Contract** | snapshot fixtures gain the additive dash fields; ts guards accept old + new | steps 6, 7 |
| **Unit (bun)** | guard/type acceptance; binding-store field decode | step 7 |

#### What stays out of tests {#test-non-goals}

- App-tests — nothing visible changes this phase; `just app-test-changed` runs as the phase-end gate for incidental coverage, no new app-test files.
- Fake-DOM/RTL render tests and mock-store assertions — banned project-wide.
- Cross-instance `/api/dash` discovery loops — the try-each loop is thin glue over the tested `resolve_port` family; the handler's ownership check is what gets the test.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Dash id in tugdash-core | done | `92598dcff` |
| #step-2 | Draft rows key by owner key | done | `e8bc6d91f` (the pre-teardown owner-key capture on the tugcast landing paths landed here with `clear_dash_draft`'s signature change, rather than in #step-3, so no commit ever carries the resolve-after-teardown ordering) |
| #step-3 | Binding column + CONTROL verbs + `/api/dash` | done | `78f8dfdfe` (`bound_sessions_by_dash` moved to #step-6, which carries its first non-test consumer — `-D warnings` rejects a method only tests call) |
| #step-4 | CLI bind/unbind + create auto-bind + `dash_gone` | done | `4c1573c64` |
| #step-5 | `tugutil dash status` | done | `160ef2452` |
| #step-6 | Extract `dash_entries`; snapshot additions | done | `5505f149f` (carries `bound_sessions_by_dash`, deferred from #step-3) |
| #step-7 | Deck plumbing | done | `966ab4cf3` |
| #step-8 | Integration checkpoint | done | verification only — see (#lifecycle-walk-result) |

#### Lifecycle walk result {#lifecycle-walk-result}

Walked on a scratch fixture repo under `TUG_CHANGES_DB` isolation, against the built CLI:

- `dash create walk` mints `tugdash/walk#<millis>-<hex>`; `dash status` reports it and every later verb agrees.
- A pre-seeded legacy `tugdash/walk` draft row is found by `draft show` through the fallback, and a `draft set` supersedes it — one id-keyed row survives, zero legacy rows.
- `dash status` walks `created` → `working` → `draft-ready` as the round and the draft land.
- `dash join walk` lands with the authored draft as its squash message and deletes the branch.
- With **no live instance to receive `dash_gone`**, the id-keyed draft row survives the join. This is Risk R02's stated residual, and it is inert rather than haunting: a second dash of the same name mints a *different* id, so `draft show` and `dash status` on it report no draft, and nothing will ever probe the dead key again. Verified directly. With an instance in the loop, the sweep is eager and complete — the #step-3 [L23] pin asserts zero surviving rows after a real join.
- Auto-bind against an instance that predates `/api/dash` warns and never fails the create, as designed.

Gates: `cargo nextest run` 2361 passed · `bun test` 6524 passed · `bunx vite build` · `just app-test-changed` (18/18 files, 35/35 tests) · core tier 20/20 after the Rust rebuild.

#### Step 1: Dash id in tugdash-core {#step-1}

**Commit:** `tugdash-core: mint a creation id per dash; expose it from every verb`

**References:** [P01], [P02], Spec S01, Risk R01, (#current-flow)

**Artifacts:** `ensure_dash_id` / `dash_owner_key` / `legacy_owner_key`; `id` on `CreateOutcome` / `DashListItem` / `ShowOutcome`; mint calls in `create` (both paths) and `commit`.

**Tasks:**
- [ ] Add the three fns beside `dash_base` in `tugdash-core/src/ops.rs` per Spec S01 (config key `branch.tugdash/<name>.tugid`, written with the same `git_output(... ["config", ...])` shape `create` uses for `tugbase`).
- [ ] `create`: fresh path mints after the config writes; idempotent path calls `ensure_dash_id` before returning; both populate `CreateOutcome.id`.
- [ ] `commit`: call `ensure_dash_id` at entry (a write-path touch that backfills old dashes).
- [ ] `list` / `show`: populate `id` via `dash_owner_key` (read-only; always `Some` in practice — the legacy fallback string is always available — with `Option` reserved for a caller that cannot resolve a repo at all).

**Tests:**
- [ ] Rust: create mints; second create returns the same id; an id-less fixture dash reads its legacy owner key from `dash_owner_key` and gains an id after `commit`.
- [ ] Rust: `legacy_owner_key("tugdash/x#123-abc") == "tugdash/x"`; passthrough for legacy strings.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: Draft rows key by owner key {#step-2}

**Depends on:** #step-1

**Commit:** `Dash drafts key by creation id; legacy name-keyed rows read and superseded`

**References:** [P03], Spec S01, Spec S02, (#current-flow)

**Artifacts:** owner resolution in `tugutil/src/draft.rs`; `legacy_owner_id` on `/api/draft`; four-probe `dash_draft_message`; both-key `clear_dash_draft`; the compose-side draft fallback.

**Tasks:**
- [ ] `tugutil/src/draft.rs`: `parse_owner`'s `dash:` arm and `resolve_owner`'s cwd-derivation resolve the owner key by reading `branch.tugdash/<name>.tugid` from the project's repo (legacy form when absent). Direct-write (`TUG_CHANGES_DB`) and API paths both send the resolved key **and** the legacy key; the direct-write supersede deletes the legacy-keyed row (extending the existing legacy-spelling delete).
- [ ] `tugcast/src/server.rs`: `DraftApiRequest.legacy_owner_id`; `apply_draft_request` folds it into `read_existing`, the `set` supersede, and the `clear` sweep — the same three places `raw_project_dir` is folded in today (Spec S02, [P03]). **Without this the migration never happens in production.**
- [ ] `tugdash-core/src/ops.rs::dash_draft_message`: four-probe read per Spec S02 (id/legacy × canonical/raw).
- [ ] `tugcast/src/feeds/agent_supervisor.rs::clear_dash_draft`: take a pre-resolved owner key instead of a dash name; delete under both keys and both spellings; extend the pinned test `releasing_or_joining_a_dash_clears_its_draft` to seed one row under each key.
- [ ] `tugcast/src/feeds/changeset.rs`: give the compose-side draft attachment its legacy fallback **now**, not in #step-6 — from this commit the CLI writes id-keyed rows while compose still keys by the branch ref, and without the fallback the maintained draft disappears from the Changes card for every dash in the window between the two steps.
- [ ] `tugcast/src/feeds/draft_engine.rs`: no change yet — the ref fix lands with the flip in #step-6 ([P09]).

**Tests:**
- [ ] Rust (tugutil, `TUG_CHANGES_DB` isolation): `draft set --owner dash:x` writes the id key; a pre-seeded legacy row is found by `draft show` when no id row exists and deleted after a `set`.
- [ ] Rust (tugcast): `apply_draft_request` with `legacy_owner_id` set — a `set` supersedes the legacy row, a `clear` sweeps it, and a `set` carrying only a selection reads the legacy row's message through the fallback instead of failing "nothing to set".
- [ ] Rust (tugdash-core, fixture repo): a join with an id-keyed draft uses it as the squash message; with only a legacy-keyed draft, likewise.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil -p tugcast`

---

#### Step 3: Binding column + CONTROL verbs + `/api/dash` {#step-3}

**Depends on:** #step-1

**Commit:** `Session↔dash binding: sessions column, bind/unbind control verbs, /api/dash`

**References:** [P04], [P05], [P08], Spec S03, Spec S04, (#current-binding-flow), (#tuglaws), Risk R02, Risk R03

**Artifacts:** migration + ledger API; binding release on close; `handle_control` arms; `dash_api.rs`; ack/bindings echo; pre-teardown clear on join/release.

**Tasks:**
- [ ] `session_ledger.rs`: `migrate_sessions_add_dash_binding` (two tolerant `ALTER TABLE`s, modeled on `migrate_sessions_add_synopsis`), called in the migration list; `set_dash_binding` / `clear_dash_bindings_for_dash` / `bound_sessions_by_dash` (one query, live sessions only — [P08]); `dash_id`/`dash_name` on the row struct `list_with_card_id` returns.
- [ ] `session_ledger.rs`: the session-close path clears `dash_id`/`dash_name` — the release half of [P08]. **[L27]: the binding is an acquisition and this is where it is returned.**
- [ ] `agent_supervisor.rs`: `bind_dash` / `unbind_dash` arms per Spec S03 with payload parsers beside the existing `parse_*_payload` fns; changeset bump on success (the same bump `do_changeset_join` fires).
- [ ] `do_spawn_session` ack and `do_list_card_bindings` rows: emit `dash_id`/`dash_name`, nulled when the dash branch no longer exists ([P05]) — the live-dash set from **one** `git for-each-ref refs/heads/tugdash/` per repo, membership-tested in memory. Not one `rev-parse` per dash: `do_list_card_bindings` is the startup restore round-trip cards wait on, and `do_spawn_session` runs on every spawn.
- [ ] `do_changeset_join` / `do_changeset_release`: capture the owner key **before** the `spawn_blocking` join/release call, and on success pass it to both `clear_dash_bindings_for_dash` and `clear_dash_draft`. **[L23]: after the call returns the branch config is gone and the key is unrecoverable (Risk R02) — this ordering is the whole mitigation, not a stylistic preference.**
- [ ] New `tugcast/src/dash_api.rs` + route registration in `server.rs` beside `/api/draft` (same loopback guard, same `spawn_blocking` discipline): `bind` / `unbind` / `dash_gone` per Spec S04; `bind` resolves the owner key via `ensure_dash_id` (write path); every `project_dir` through `resolve_to_claude_form` on arrival (**[L29]**).

**Tests:**
- [ ] Rust (tugcast): bind → `list_card_bindings_ok` carries the fields → unbind → nulls; bind then delete the branch in the fixture → fields null on read ([P05]).
- [ ] Rust (tugcast), **the [L23] pin**: seed an id-keyed draft and a binding, run join to completion, then assert — with the branch and its config gone — that both rows are gone. The same test with the key resolved *after* the join must fail; that is what makes it a pin rather than a formality.
- [ ] Rust (tugcast), **the [L27] pin**: bind two sessions to one dash, close one → `bound_sessions_by_dash` reports one; close the other → the dash reports zero and reads as parked.
- [ ] Rust (tugcast), **the [L29] pin**: `/api/dash` bind with a non-canonical `project_dir` spelling resolves to the same session row as the canonical spelling.
- [ ] Rust (tugcast): `/api/dash` bind for an unknown session answers `unknown_session`; `dash_gone` clears rows and reports the count.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 4: CLI bind/unbind + create auto-bind + `dash_gone` {#step-4}

**Depends on:** #step-3

**Commit:** `tugutil dash bind/unbind; create auto-binds; join/release broadcast dash_gone`

**References:** [P04], [P05], Spec S04, (#q03-cli-bind-route)

**Artifacts:** `DashCommands::{Bind, Unbind}` + dispatch; `post_dash_api`; create/join/release glue.

**Tasks:**
- [ ] `cli.rs`: `Bind { name }` / `Unbind` variants (unbind takes no name — it clears the calling session's binding); `dash.rs` dispatch. `--project` defaults to cwd and travels as the user's own spelling ([L29] — the CLI never canonicalizes).
- [ ] `dash.rs::post_dash_api`: try the cwd-derived instance first (`registry::find_for_cwd`, which reaches through a dash worktree to its main checkout), then walk `tugcore::registry::list_live()`, POSTing until `ok`; `unknown_session` continues the loop; exhaustion is an actionable error for `bind`/`unbind` and a warning for `dash_gone`. `resolve_port_*` is the wrong primitive here — it collapses to one port by design ([P04]).
- [ ] `bind` requires `TUG_SESSION_ID` (error otherwise, same message style as `resolve_owner`'s no-owner error).
- [ ] `create` dispatch: after a successful create with `TUG_SESSION_ID` set, best-effort bind (warn on failure, never fail the create).
- [ ] `join` / `release` dispatch: capture the owner key via `dash_owner_key` **before** invoking the verb, then on success broadcast `{op: "dash_gone", project_dir, dash_id: <captured>}` to every live instance, best-effort. **[L23]/Risk R02: the branch config is gone by the time the verb returns — a key resolved afterwards silently matches nothing.**

**Tests:**
- [ ] Rust (tugutil): `dash bind` without `TUG_SESSION_ID` exits 1 with the actionable message; `--json` envelopes parse.
- [ ] Rust (tugutil, fixture repo): the owner key captured by the `join` dispatch is the id-qualified form, and it is still the id-qualified form in the `dash_gone` body after the join has deleted the branch.
- [ ] Rust (tugcast, exercising the handler the CLI targets): bind→unbind round-trip through `/api/dash` over a test server, covering the response shapes the CLI decodes.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugcast`

---

#### Step 5: `tugutil dash status` {#step-5}

**Depends on:** #step-3

**Commit:** `tugutil dash status: one machine-readable lifecycle readout`

**References:** [P06], Spec S05, (#state-model in the program plan; #current-flow)

**Artifacts:** `ops::status_in` + `DashStatus`; `DashCommands::Status` + dispatch; plain and `--json` output.

**Tasks:**
- [ ] `status_in(repo_root, name)`: compose from existing helpers — `dash_owner_key`, `dash_base`, round count (as `list` does), worktree + dirt (as `show` does), draft presence (`dash_draft_message(...).is_some()`), join-journal phase (read the journal file `show`'s siblings use in `join_in`), `bound_sessions` via `sessions_db_file()` read-only, **live sessions only and under the same predicate `bound_sessions_by_dash` uses** ([P08]) — empty on any failure, including a `sessions.db` whose `dash_id` column has not been migrated in.
- [ ] Stage derivation per [P06] as a pure fn with the precedence `landing > draft-ready > working > created`, unit-tested on synthesized inputs.
- [ ] `step_current`/`step_total` emitted as JSON nulls (Phase 3's slots).

**Tests:**
- [ ] Rust unit: stage precedence table.
- [ ] Rust integration (fixture repo): fresh dash → `created`; after a round → `working`; after `draft set` → `draft-ready`; journal present → `landing`.
- [ ] Rust: `bound_sessions` is empty for a dash whose only bound session is closed ([P08]) — the CLI-side face of the [L27] pin.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 6: Extract `dash_entries`; snapshot additions {#step-6}

**Depends on:** #step-1, #step-3

**Commit:** `Dash snapshot entries compose from tugdash-core; entries carry id, stage, bound sessions`

**References:** [P02], [P05], [P06], [P08], [P09], Spec S06, (#extraction-target)

**Artifacts:** `dash_detail_entries_in` in tugdash-core; deleted `feeds/changeset.rs::dash_entries`; extended `ChangesetEntry::Dash` with `branch`; `draft_engine` ref fix; updated fixtures.

**Tasks:**
- [ ] `tugdash-core`: `dash_detail_entries_in(repo_root)` returning the per-dash detail the feed needs (name, owner key, branch ref, base — via `dash_base`'s detection fallback, adopted deliberately over the duplicate's bare `"main"` default — rounds, worktree rel/abs + dirt with the legacy-home fallback from `worktree_path`, name-status files, newest-first round subjects). Pure read path: `dash_owner_key`, never `ensure_dash_id` ([P02]).
- [ ] `feeds/changeset.rs`: replace the `dash_entries` body with a `spawn_blocking` call into tugdash-core; map into `ChangesetEntry::Dash`; delete the local sanitizer/parsing duplicates.
- [ ] `tugcast-core/src/types.rs`: add `branch`, `stage`, `bound_sessions`, `step_current`, `step_total` (all optional/serde-defaulted) to `ChangesetEntry::Dash`; **`owner_id` becomes the owner key** and no separate `id` field is added ([P09]). `stage` computed in compose from the same pure derivation as #step-5 (share it from tugdash-core); `bound_sessions` from **one** `bound_sessions_by_dash()` call per compose, fanned out across entries ([P08]) — never a query per dash.
- [ ] `feeds/draft_engine.rs`: `DraftTarget::Dash` takes its git ref from the entry's `branch`; the `let branch = owner_id.clone()` assumption and its comment go. **[P09], and the "`owner_id` flip silently breaks dash draft generation" row of (#risks): without this the flip kills dash draft generation silently — empty `rev-parse`, empty diff, degenerate fingerprint, no error anywhere.** The `EntryKey.owner_id` keeps carrying the owner key, so generated drafts land on the row the readers probe first.
- [ ] Draft attachment in compose: already carries the Spec S02 legacy fallback from #step-2; confirm it against the flipped `owner_id`.
- [ ] Update golden snapshot fixtures.

**Tests:**
- [ ] Rust: `compose_derives_dash_entries_from_tugdash_refs` passes against the extracted implementation (extended to assert `owner_id`/`branch`/`stage`/`bound_sessions`).
- [ ] Rust: an id-less dash composes with the legacy `owner_id` and still attaches its legacy-keyed draft.
- [ ] Rust: `gather_dash` on an id-keyed entry produces a non-empty fingerprint and prompt — the assertion that would have caught the silent break.
- [ ] Rust: `entry_sort_key` orders `demo` before `demo2` with both carrying ids ([P09] — `#` sorts below alphanumerics; assert it rather than rely on it).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`

---

#### Step 7: Deck plumbing {#step-7}

**Depends on:** #step-3, #step-6

**Commit:** `Deck carries the dash binding and the extended dash entry; nothing renders yet`

**References:** [P07], Spec S03, Spec S06, (#state-zone-mapping)

**Artifacts:** extended `DashChangesetEntry` + guards; `CardSessionBinding.dash`; ack/bindings decode.

**Tasks:**
- [ ] `changeset-types.ts`: additive optional fields per Spec S06 (`branch`, `stage`, `bound_sessions`, `step_*`); guards accept old and new shapes; move the "dash branch ref" doc comment off `owner_id` onto `branch` and describe `owner_id` as the opaque identity; update `__tests__/changes-route-controller.test.ts`, which asserts `owner_id === "tugdash/fix-join"`.
- [ ] `card-session-binding-store.ts`: `dash?: { id: string; name: string }` on `CardSessionBinding`, plus `setDashBinding(cardId, dash | null)` — a **merge**, since `setBinding` replaces the whole record and a mid-session bind must not clobber `workspaceKey`/`projectDir` ([P07]).
- [ ] `action-dispatch.ts`: populate `dash` from `spawn_session_ok`'s `dash_id`/`dash_name` in the same handler that populates `workspaceKey`.
- [ ] `protocol.ts`: `CardBinding` gains the nullable dash fields — **decode only**. `session-restore.ts` writes no bindings today (it matches rows and re-spawns; the ack is the single writer, and the clear-then-restore contract depends on that) and must not start ([P07]).
- [ ] `bind_dash_ok` / `unbind_dash_ok` broadcast handling: `setDashBinding` for the affected session (`cardIdForSession` gives the reverse walk), so a bind issued by a skill mid-session reaches the store without a respawn.

**Tests:**
- [ ] bun: guards accept a legacy dash entry (no new fields) and an extended one; binding decode round-trip for ack rows with and without dash fields.
- [ ] bun: `setDashBinding` preserves `workspaceKey`/`projectDir` on an existing binding and no-ops on an unknown card.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-2, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk the lifecycle on a fixture/scratch repo end to end: `dash create x` (id minted, auto-bind attempted) → `draft set --owner dash:x` (id-keyed row, legacy row superseded **through the server**) → `dash status x --json` (stage `draft-ready`, draft true, bound session listed) → `dash join x` (draft used as message; `dash_gone` broadcast with the pre-captured key) → **query `changes.db` via `just db-inspect` and confirm zero rows survive under either key**, and no session row still carries the dead `dash_id`.
- [ ] Re-run the walk with the session closed before the join: `bound_sessions` empties on close, the dash reads as parked, and the join still clears cleanly ([P08]).
- [ ] Confirm no step introduced a visible UI change (the phase's contract).

**Tests:**
- [ ] The full suites, as below.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Dashes have durable creation identities; sessions bind to dashes server-authoritatively with CLI, CONTROL, and HTTP surfaces; `dash status` answers the lifecycle question machine-readably; the changeset snapshot carries id, stage, and mated sessions from a single shared composition — with zero visible UI change.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every Success Criterion in (#success-criteria) verified by its named test.
- [ ] Every law in (#tuglaws) has its named pin, green — [L23] resolve-before-teardown, [L27] release-on-close, [L29] gateway on `/api/dash`, [L02] store discipline, [LR8] one writer.
- [ ] `feeds/changeset.rs` contains no dash-composition logic of its own.
- [ ] No code path derives a git ref from `owner_id` ([P09]).
- [ ] A dash created by an older build (no `tugid`) round-trips every verb and the feed under its legacy identity.

**Acceptance tests:**
- [ ] The #step-8 lifecycle walk.
- [ ] `cargo nextest run` / `bun test` / `bunx vite build` / `just app-test-changed` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Phase 2: render `snapshot.dashes` (Changes lane, chrome chip, Lens section, `/dash` gesture).
- [ ] Phase 3: `dash step` verbs fill `step_current`/`step_total`; declared stages join the derivation.
- [ ] [Q02] cross-instance `bound_sessions` aggregation, if a real workflow demands it.

| Checkpoint | Verification |
|------------|--------------|
| Identity + drafts | tugdash-core/tugutil suites (#step-1, #step-2) |
| Binding | tugcast supervisor + `/api/dash` suites (#step-3, #step-4) |
| Status + snapshot | tugdash-core/tugcast suites (#step-5, #step-6) |
| Deck plumbing | bun + vite build (#step-7) |
| Phase | #step-8 aggregate |
