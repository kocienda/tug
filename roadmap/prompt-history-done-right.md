# Prompt History Done Right {#prompt-history-done-right}

**Purpose:** Move prompt history out of tugbank defaults into a machine-global, append-only SQLite ledger so every prompt the user ever submits is kept, complete and forever, while removing the history domain's weight from the boot-critical DEFAULTS frame. Retire every storage cap and trimming shim the old home forced into existence.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-17 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-17, opus.** Reviewed `plan:0b7dfe49e40846b0`. Lint: 0 errors, 0 warnings on entry; 1 error introduced and fixed mid-round (PL020 fired on a Tests line that said "no mock-store assertions" — the linter matches the phrase, not the intent, so the line was reworded to describe what it does assert).
Oriented on: the whole document (first round, `rounds: 0`).
Applied: **sequencing** — Step 6 depended on #step-3, but Step 3 only threads the ledger *parameter* while #step-5 is what opens it in `main.rs`; with the ledger unopened the `Extension` is `None`, the routes never register, and every append 404s, so the step could not be verified until a later step landed. Re-pointed to #step-5 with the reasoning inline. **Build break** — retiring the startup prune orphans `prune_orphaned_session_keys`, whose only non-test caller is `main.rs`; under the workspace's `-D warnings` the resulting `dead_code` is a hard failure, so Step 5 now deletes the function and `test_prune_orphaned_session_keys` with it, and the inventory records why. **Test layering** — Step 3 proposed `tower::ServiceExt::oneshot` handler tests; no axum handler in tugcast is tested that way (every `oneshot` in the crate is `tokio::sync::oneshot`), and `attachments.rs`/at0413 establish the pure-helpers-plus-app-test split this plan should follow, so the step now tests the request→ledger seam and defers the HTTP contract to at0437, with an explicit note not to grow a new in-crate HTTP idiom. **Law [L31]** — the plan had a silent-failure path: a failed append, or an unopenable ledger, lost the prompt with no user-visible consequence, which is precisely what L31 was written from; Spec S04 now requires a visible card notice on exhausted retries and forbids the store reporting a corpus it failed to write. **Correctness hole in [P08]** — `back()`'s existing `if (entries.length === 0) return null` means a route-starved provider never triggers `extendOlder`, leaving permanent starvation, the bug [P08] exists to fix; the edge condition is now "cannot advance within this route AND `hasMore`". **Correctness trap** — the re-seed loop must keep writing a bytes-store marker for *every* image atom, not just path-bearing ones, or the submit gate blocks every recalled legacy prompt with "still processing"; recorded as a named trap in the Deep Dive and as a Step 6 task. **Ordering** — recall order is ledger `id` order, so a retrying append must block later same-session appends or a failure inverts two prompts; Spec S04 now serializes per session and states `submitted_at_ms` is never the sort key. **Precision against the tree** — `changes.db`'s schema *sidecar* is a downgrade guard for a corrupt shared ledger and is deliberately not replicated (Spec S01); the quit flush site is named as `DeckManager.teardownSave`; the router change is three signatures (`build_app`, `run_server`, and the `main.rs` call site); the "domain absent" criterion became "zero entries" because deleting keys leaves the empty domain row. **Added** a mandated law cross-check ([L02], [L22]/[L24], [L23], [L29], [L31]) — including that the persisted `path` is server-minted and never compared, so it is not a new L29 exposure, while `project_path` must route through the gateway if ever populated — and a Deep Dive on the shared-ledger/per-instance-attachments interaction, which errs strictly toward retention.
Deferred: nothing was deferred. One scope call was asked rather than assumed — whether to recover the prompts the old caps already destroyed by reading the Claude JSONL transcripts — and the user settled it in the negative during the round; it is recorded as decided in [P09] and carried into #non-goals and the follow-on roadmap, so no `[Q##]` remains.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Prompt history — the Up-arrow recall corpus in the Session card's prompt entry — is persisted today as JSON blobs in tugbank defaults (domain `dev.tugtool.prompt.history`, one key per session, written by `putPromptHistory` in `tugdeck/src/settings-api.ts`). That home is structurally wrong for a growing log, and every observed defect follows from it:

1. **The DEFAULTS feed re-serializes every value of every domain into one frame on every write** (`build_domain_entries` in `tugrust/crates/tugcast/src/feeds/defaults.rs` — no limit, no window, no key filter), and the `on_domain_changed` callback rebuilds that full frame on any single-key change. The frame is a snapshot watch delivered synchronously during the WebSocket `Live` handshake (`tugrust/crates/tugcast/src/router.rs`, the send loop that awaits each snapshot frame before the client goes live), so history bytes sit directly on the launch-critical path.
2. **Above `SAFE_DEFAULTS_FRAME_BYTES` (14 MiB, `feeds/defaults.rs`) domains are shed largest-first with a warning** — and the shed test (`test_oversized_domain_is_shed_from_frame` in `feeds/defaults.rs`) literally uses `dev.tugtool.prompt.history` as its bloated-domain exemplar. A growing log is by construction the first casualty.
3. To survive inside that regime, the client grew caps that silently destroy user data: `MAX_ENTRIES_PER_SESSION = 200` (`tugdeck/src/lib/prompt-history-store.ts`), `MAX_PROMPT_HISTORY_BYTES = 192 KiB` and `MAX_PERSISTED_THUMBNAILS = 4` with `boundPromptHistoryForPersist` (`tugdeck/src/settings-api.ts`). Measured on the live `release-main` bank: sessions with 175 submitted prompts retain 33; base64 thumbnails consume 86–97% of the byte budget, so the backstop evicts hundreds of text prompts to reclaim kilobytes.
4. The write is a fire-and-forget `PUT` of the whole re-serialized list on every submit — a lost write loses the prompt permanently.

The requirement this plan serves is absolute: **the user's prompts are saved, all of them, forever**. No cap, no trim, no lossy fallback. And the storage must be fully lazy — zero bytes of history on the boot frame, zero work at launch.

#### Strategy {#strategy}

- Store prompts in a new machine-global, append-only SQLite ledger `prompt_history.db` (one row per submitted prompt), opened through the mandated `tugcore::ledger_db` gateway, integrity-gated like every other ledger.
- Serve it over two loopback-gated HTTP routes on tugcast: an idempotent append and a keyset-paged read. HTTP (not a CONTROL op) because the CONTROL bus is an uncorrelated broadcast and a page applied twice prepends twice; HTTP request/response gives correlation for free.
- Make the client store a lazily-paged window over the ledger: nothing fetched at boot, first page fetched on first composer mount per session, older pages fetched on demand as the user arrows past the loaded window.
- Persist **references, never pixels**: a history atom carries `path` (the stored original in `draft-attachments/`), never `thumbnailDataUrl`. Previews re-bake from bytes on recall via the existing `rehydrateDraftAttachments` machinery — the same doctrine durable card state already ships (`capAttachmentBytes` in `tugdeck/src/settings-api.ts`).
- Extend the `draft_gc` root set to include the ledger **in the same change** that migrates references out of tugbank, so the sweep never sees a world where history references are invisible.
- Migrate existing tugbank history into the ledger at startup (idempotent, crash-safe), then delete the domain — removing ~1.1 MB from the live boot frame immediately.
- Sequence: Rust ledger first (with tests), then routes, then GC + migration together, then the client rewrite, then retirement of the old code, then the relaunch app-test.

#### Success Criteria (Measurable) {#success-criteria}

- Submitting N prompts across app relaunches yields N recallable prompts — verified by the new app-test (at0437), which submits prompts, quits the app, relaunches, and asserts the full corpus recalls (no 200-entry, 192 KiB, or thumbnail-count truncation anywhere in the path).
- The boot DEFAULTS frame carries no prompt-history *entries* after migration — verified by the app-test asserting `GET /api/defaults/dev.tugtool.prompt.history` returns no keys, and by the migration unit test. (Stated as "no entries", not "no domain": deleting every key leaves the domain row in tugbank's `domains` table, so `list_domains` still returns it and the frame carries an empty `{"generation":N,"entries":{}}` object — a few dozen bytes, permanently.)
- Persisted history rows contain no base64 image data — verified by a Rust unit test asserting `atoms_json` for an appended entry with an image atom carries `path` and no `thumbnailDataUrl` key (client strips it; server test guards the wire contract via the append route test).
- A prompt whose append hits a transient network failure is retried and lands — verified by a client unit test of the outbox retry.
- `draft_gc` retains an attachment referenced only by a ledger row — verified by a Rust unit test that seeds a ledger row referencing a UUID and asserts the sweep keeps the file.
- `cd tugrust && cargo nextest run` passes with zero warnings; `cd tugdeck && bunx vite build` passes; `just app-test-changed` selection passes.

#### Scope {#scope}

1. New Rust module `prompt_ledger.rs` in tugcast: schema, open/integrity-gate, append, keyset page, tugbank import migration, unit tests.
2. Path plumbing in `tugcore::instance`: `prompt_history_db_path()` + `TUG_PROMPT_HISTORY_DB` override; harness wiring so app-tests never touch the real corpus.
3. Two HTTP routes on tugcast: `POST /api/prompt-history` (append) and `GET /api/prompt-history` (page).
4. `draft_gc` root-set extension: ledger `atoms_json` joins the two tugbank domains as reference roots.
5. One-time startup migration: tugbank domain → ledger, then domain deletion; retire the orphaned-key prune for this domain.
6. Client rewrite: `prompt-history-store.ts` becomes a paged window over the ledger; new `prompt-history-api.ts` with an awaited, retrying append outbox and quit flush; reference-only atom serialization; path backfill for the submit-before-upload race.
7. Retirement: `MAX_ENTRIES_PER_SESSION`, `MAX_PROMPT_HISTORY_BYTES`, `MAX_PERSISTED_THUMBNAILS`, `boundPromptHistoryForPersist`, `putPromptHistory`, `getPromptHistory`, `truncateSession`, and the startup prompt-history prune.
8. App-test at0437: submit → relaunch → full-corpus recall.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Full-text search over the prompt corpus (FTS5). The schema makes it possible later; nothing here builds it.
- Cross-session or cross-project recall UI. The ledger is machine-global so the data supports it; recall stays session-scoped in this phase.
- Any change to `draft-attachments/` storage itself (upload routes, naming, downsample pipeline) beyond the GC root set.
- Retention/pruning policy for the ledger. It is append-only and unbounded by design; disk cost is negligible (measured prompts average ~200 bytes; 100k prompts ≈ 20 MB).
- Changing shell-exchange history (`shell_ledger.rs`) or its 500-row cap.
- Recovering prompts the old caps already destroyed by reading them back out of the Claude JSONL transcripts ([P09]).

#### Dependencies / Prerequisites {#dependencies}

- `tugcore::ledger_db` gateway and its enforcement test (`no_ad_hoc_ledger_opens`, `tugrust/crates/tugcore/src/ledger_db.rs`).
- `ledger_integrity::integrity_gate` / `salvage_into` (`tugrust/crates/tugcast/src/ledger_integrity.rs`).
- The existing attachment facility: `POST /api/attachments`, `draft-attachments/`, `rehydrateDraftAttachments` (`tugdeck/src/lib/attachment-upload.ts`), `AtomBytesStore` (`tugdeck/src/lib/atom-bytes-store.ts`).
- App-test harness env plumbing (`tests/app-test/_harness/index.ts`, which already sets `TUG_CHANGES_DB` into the instance dir).

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`-D warnings`).
- `Connection::open(` must never appear in production sources — every writable open goes through `tugcore::ledger_db::open` (enforced by `no_ad_hoc_ledger_opens`). `Connection::open_in_memory()` is legal (does not match the banned substring).
- The literals `dirs::data_dir(` and `"Application Support/Tug"` are banned outside `tugcore/src/instance.rs` (enforced by `no_ad_hoc_data_dir_resolution`, `tugrust/crates/tugcore/src/instance.rs`); all path resolution goes through an `instance::*` helper.
- A machine-global DB means multiple tugcast processes (release + debug + dashes) may write concurrently: WAL + `busy_timeout = 5000` from `ledger_db::apply_pragmas` must suffice (appends are single-row, short transactions).
- Frontend state changes obey tuglaws: external state enters React through `useSyncExternalStore` only [L02]; persistence never goes through Web storage.
- No `tugbank` writes for history anywhere after this phase — the domain ceases to exist.

#### Assumptions {#assumptions}

- `tugSessionId` is the stable key for a session across `--resume` (verified in `tugdeck/src/lib/code-session-store.ts` `frameToEvent`'s divergence check and `reducer.ts` `handleSessionInit`: tugdeck operates on the single picker-chosen id).
- The live tugbank domain values parse as `HistoryEntry[]` JSON (verified against the real `release-main` bank: `[{"atoms":[...],"id":"<session>-<ms>","projectPath":"","route":"❯","sessionId":"...","text":"...","timestamp":...}, ...]`).
- Existing pathless image atoms (all 10 observed in the live bank predate path persistence) migrate as-is and recall without previews; this is accepted data loss of *derived* pixels only — the prompt text is kept.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

*(none — all design questions were settled in-session and are recorded as decisions below)*

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Concurrent writers (multiple instances) contend on the shared DB | low | med | WAL + 5 s busy_timeout; single-row inserts | `database is locked` warnings in logs |
| Migration deletes tugbank domain before rows verifiably landed | high | low | Per-key import → verify → delete, idempotent via `client_entry_id` | any import warn! in logs |
| GC deletes attachments referenced only by ledger rows | high | low | Root-set extension lands in the same step as the migration; unreadable ledger aborts the sweep | Risk R01 |
| Recall regression at the window edge (arrow past loaded page) | med | med | Provider triggers older-page fetch and notifies on arrival; store test covers the edge | user reports dead Up-arrow presses |

**Risk R01: GC root-set gap during rollout** {#r01-gc-root-set-gap}

- **Risk:** After history references leave tugbank, `draft_gc::sweep_at_startup` (whose root set is exactly the two tugbank domains) would treat every history-referenced attachment as garbage and delete it once the 7-day grace expires.
- **Mitigation:**
  - The root-set extension and the migration ship in the same step (#step-4) — no commit exists where references are out of tugbank but invisible to the sweep.
  - An unreadable/absent prompt ledger aborts the sweep entirely (retain-everything), mirroring the existing unreadable-root-domain policy in `sweep_at_startup`.
  - The 7-day `GRACE` gives a full week of slack even against an unforeseen ordering hole.
- **Residual risk:** none identified beyond "a bug in the new root-set query," which the unit test in #step-4 pins.

---

### Design Decisions {#design-decisions}

#### [P01] Prompt history lives in an append-only SQLite ledger, not tugbank (DECIDED) {#p01-ledger-not-tugbank}

**Decision:** Persist prompt history as one row per submitted prompt in a new `prompt_history.db`, opened via `tugcore::ledger_db`; the tugbank domain `dev.tugtool.prompt.history` is migrated in and deleted.

**Rationale:**
- tugbank defaults re-serializes every value of every domain into one frame on every write and delivers it on the boot-critical path (`feeds/defaults.rs` `build_domain_entries` + `on_domain_changed`; `router.rs` snapshot-watch send loop). A growing log there regresses launch monotonically and is then silently shed at 14 MiB (`SAFE_DEFAULTS_FRAME_BYTES`).
- Every client-side cap (`MAX_ENTRIES_PER_SESSION`, `MAX_PROMPT_HISTORY_BYTES`, `MAX_PERSISTED_THUMBNAILS`) exists only to survive that regime, and each one destroys user prompts. Row storage has no per-value ceiling and no reason to trim.
- An append is one `INSERT`, not a re-serialize-and-PUT of the whole list.

**Implications:**
- New Rust module, routes, and client API; the DEFAULTS feed never carries history again.
- The `draft_gc` root set must extend to the ledger (Risk R01, [P04]).

#### [P02] The ledger is machine-global (shared top-level), not per-instance (DECIDED) {#p02-machine-global}

**Decision:** `prompt_history.db` lives at `base_data_dir()/prompt_history.db` (beside `changes.db`), independent of `TUG_INSTANCE_ID`, with a `TUG_PROMPT_HISTORY_DB` env override for isolated test runs.

**Rationale:**
- Prompts are the user's corpus, not an instance's. Measured live: `release-main` holds 23 session histories; every one of 15 dash/debug instances holds 0 or a stray handful — per-instance storage means switching builds loses recall.
- The doctrine already exists for `changes.db` (`tugcore/src/instance.rs` `changes_db_path`: "the working tree is machine-global, so splitting attribution per instance splits the truth") and `jots.json` (`jots_path`: "the user's phrasebook, the same across every build").

**Implications:**
- Multiple tugcast processes may write concurrently → WAL + busy_timeout (see Constraints); no writer-lock claim (appends are tiny and idempotent; the `claim_writer` machinery exists for `changes.db`'s single-relay regime, which does not apply here).
- Schema evolution uses a `PRAGMA user_version` gate with registered migrations (the shared-DB regime), not bare `CREATE IF NOT EXISTS` self-healing (the per-instance regime described in `session_ledger.rs`'s bootstrap doctrine).
- App-tests must set `TUG_PROMPT_HISTORY_DB` into the instance dir (mirroring the existing `TUG_CHANGES_DB` line in `tests/app-test/_harness/index.ts`).

#### [P03] History persists references, never pixels (DECIDED) {#p03-references-not-pixels}

**Decision:** A persisted history atom carries `{id, position, type, label, value, path?}` — `thumbnailDataUrl` is stripped at append serialization and removed from the persisted contract. Previews re-bake from the stored original on recall.

**Rationale:**
- Thumbnails are derived data: `rehydrateDraftAttachments` (`tugdeck/src/lib/attachment-upload.ts`) already reads the original via `GET /api/fs/blob`, downsamples, and bakes a fresh thumbnail — the recall path fetches the bytes anyway to make the prompt resubmittable.
- Durable card state decided this exact question already (`capAttachmentBytes` in `settings-api.ts`: "No image data of any kind is persisted here, not even the baked thumbnail: it is derivable from the bytes the restore is already fetching") after thumbnails-on-every-save caused the ~18 MB boot stall. Measured in the live bank, thumbnails were 86–97% of history's byte budget.

**Implications:**
- The in-memory `AtomBytesStore` entry keeps its thumbnail, so recall within a running session stays instant; only cold-launch recall pays one fetch+bake, painting a reserved slot briefly (same as card-state restore today, pinned by at0413).
- Legacy migrated atoms that carry a thumbnail but no path lose the preview permanently (nothing to re-bake from); their text and structure are kept.

#### [P04] The draft-gc root set gains the ledger, in the same change as the migration (DECIDED) {#p04-gc-root-set}

**Decision:** `draft_gc::sweep_at_startup` reads `atoms_json` from the prompt ledger and appends those strings to `root_json` alongside the two tugbank domains; if the ledger cannot be read, the sweep is skipped entirely (retain-everything). This lands in #step-4 together with the migration.

**Rationale:**
- `draft_gc.rs`'s own contract: "A future feature that stores one of these references anywhere else must add itself to the root set, or this sweep will delete bytes it still needs."
- The UUID-stem substring predicate is unchanged — `atoms_json` text containing the attachment's UUID retains the file exactly as tugbank JSON text does today, and the module's no-path-comparison doctrine is preserved.

**Implications:**
- `sweep_at_startup`'s signature gains the ledger handle; `main.rs` passes it; a unit test seeds a ledger row and asserts retention.
- The query is `SELECT atoms_json FROM prompt_history WHERE atoms_json != '[]'` — only rows that can possibly hold a reference.

#### [P05] Appends are awaited and retried; reads are keyset-paged over HTTP (DECIDED) {#p05-http-contract}

**Decision:** `POST /api/prompt-history` appends one row (idempotent on `client_entry_id`, returns the ledger `id`); `GET /api/prompt-history?session=&before=&limit=` returns `{entries, has_more, before}` keyset-paged newest-backward. The client keeps an in-memory outbox that retries failed appends and flushes synchronously at quit.

**Rationale:**
- Today's fire-and-forget PUT is itself a loss vector; an unbounded corpus needs paging, and offset paging slides under concurrent appends — keyset (`WHERE id < ?before ORDER BY id DESC LIMIT ?+1`, probe row for `has_more`) is the established shape (`SessionLedger::list_overview_posts_page` in `session_ledger.rs`).
- HTTP over CONTROL: the CONTROL bus is an uncorrelated broadcast; its own paging precedent (`do_list_overview_posts` in `agent_supervisor.rs`) documents that a page applied twice prepends twice, forcing cursor-echo discipline. HTTP correlates request and response natively.
- Loopback-gated like `POST /api/attachments` (`attachments.rs`).

**Implications:**
- New `tugdeck/src/lib/prompt-history-api.ts`; the quit flush mirrors `putCardState`'s synchronous-XHR branch (`settings-api.ts`, `options.sync`).
- `client_entry_id` (the client-minted entry id) gets a `UNIQUE` index; a conflicting append returns the existing row's id, making retries and the migration idempotent by construction.

#### [P06] `/rewind` no longer truncates prompt history (DECIDED) {#p06-rewind-keeps-history}

**Decision:** Delete `PromptHistoryStore.truncateSession` and its `/rewind` call site in `tugdeck/src/components/tugways/cards/session-card.tsx`; a conversation rewind leaves the recall corpus intact.

**Rationale:**
- The governing requirement is that prompts are never destroyed. A rewound-away prompt is precisely the one the user most plausibly wants to recall and resubmit in edited form.
- The existing implementation is also incorrect: it derives `keepCount` by counting `user_message` rows in `codeSnap.transcript`, which is only the **loaded replay window** (`ReplayWindowMeta.hasOlder` in `tugdeck/src/lib/code-session-store/types.ts`); on a partially-loaded session it undercounts and keeps only that many *oldest* entries, destroying valid recent history — the comment's idempotence claim holds only with the full transcript resident. Rather than fix a windowing bug in a deletion feature, delete the deletion.

**Implications:**
- The ledger needs no delete path at all — it is genuinely append-only.
- Any unit test pinning truncation behavior is removed with the feature.

#### [P07] Migration is import-verify-delete at startup, per key, idempotent (DECIDED) {#p07-migration}

**Decision:** At tugcast startup (before `defaults_feed` is created), each instance imports its own tugbank `dev.tugtool.prompt.history` domain into the shared ledger — parse each key's `HistoryEntry[]`, `INSERT OR IGNORE` by `client_entry_id`, verify each entry landed, then delete that tugbank key. A key that fails to parse or verify is left in place with a `warn!` and retried next launch.

**Rationale:**
- Idempotent via the `UNIQUE(client_entry_id)` constraint: a crash between insert and delete re-imports harmlessly next launch.
- Running before `defaults_feed` means the very first boot frame after upgrade already excludes the domain (~1.1 MB lighter on the live release bank). The one-time cost is parsing ~1 MB of JSON — microseconds against a launch, and zero on every subsequent launch (domain absent).
- Per-instance import naturally unifies the corpus: release-main, debug-main, and every dash instance each fold their own history in as they next launch.

**Implications:**
- The legacy entry `id` field becomes `client_entry_id`; `timestamp` → `submitted_at_ms`; `sessionId`/`projectPath`/`route`/`text` map to columns; `atoms` serialize to `atoms_json` **with `thumbnailDataUrl` dropped** ([P03]).
- The startup orphaned-key prune for this domain (`main.rs`, `prune_orphaned_session_keys` over `PROMPT_HISTORY_DOMAIN`) is retired in the same step — it exists to stop domain bloat the domain no longer has, and pruning a shared corpus against one instance's `sessions.db` would be wrong.

#### [P08] The client store is a contiguous newest-suffix window per session (DECIDED) {#p08-window-model}

**Decision:** `PromptHistoryStore` holds, per session, a contiguous window of the newest rows (first page fetched on first provider creation, ~200 rows), extended backward by fetching older pages when a provider's `back()` reaches the window's oldest entry and `has_more` is true. Route providers filter within the window, as today.

**Rationale:**
- Preserves every existing consumer contract (`getSessionEntries` for the thumbnail re-seed, route filtering, cursor semantics) with the smallest reshaping.
- Route starvation (a busy `$` route consuming the whole window) degrades from *permanent data loss* under the old cap to *one more page fetch* — the presses that hit the edge trigger the fetch, the store notifies on arrival, and the next press lands.
- Session-scoped pages (no server-side route filter) keep the HTTP contract minimal; the `route` column exists for a future filtered query if ever needed.

**Implications:**
- **The edge condition is "cannot advance within this route", not "the window is empty".** `back()` must kick `extendOlder` whenever it cannot move further back *within its own route filter* and the session window still reports `hasMore` — that covers both the at-oldest case and the zero-route-entries case. The current implementation's `if (entries.length === 0) return null;` early return would otherwise leave a route-starved provider permanently dead, which is the very bug [P08] exists to fix. The press that triggers the fetch returns `null` (matching the existing "returns null until loading completes" provider contract); the store notifies on arrival and the next press lands.
- RAM is bounded by the window, storage is not.
- The memory cap logic (`MAX_ENTRIES_PER_SESSION` splices) is deleted, not enlarged.

#### [P09] Already-destroyed prompts are not recovered from JSONL (DECIDED) {#p09-no-jsonl-recovery}

**Decision:** The migration imports only what tugbank still holds. Prompts the old caps already evicted (measured: dash-xp retains 33 of 175 submitted) stay gone; no JSONL reconstruction pass ships in this phase.

**Rationale:**
- Asked and settled by the user during review. The guarantee this plan buys is forward-looking: from the ledger onward, nothing is ever discarded.
- A JSONL recovery pass is a materially different problem — project-slug resolution, `user_message` extraction across schema vintages, synthetic entry ids that dedup against migrated rows — and bolting it onto this plan would put the durability guarantee behind an archaeology project.

**Implications:**
- No JSONL reader, no slug resolution, no synthetic-id scheme in scope (#non-goals).
- The at0437 acceptance test measures prompts submitted *after* the ledger exists, never a historical count.

---

### Deep Dives {#deep-dives}

#### Current write/read topology being replaced {#current-topology}

Write: four `historyStore.push(...)` call sites in `performSubmit` (`tugdeck/src/components/tugways/tug-prompt-entry.tsx` — local slash command, swallowed slash command, shell route, Claude submit; only the Claude site persists atoms). `push` appends in memory, enforces the 200 cap, and fires `putPromptHistory(sessionId, entries)` — a whole-list, fire-and-forget PUT to `/api/defaults/dev.tugtool.prompt.history/{sessionId}`, bounded by `boundPromptHistoryForPersist` (thumbnail count trim, then oldest-entry byte backstop).

Read: `createRouteProvider` (memoized per `${sessionId}|${route}` in `tug-prompt-entry.tsx`) kicks `loadSession`, which GETs the whole persisted list and merges by entry id. A `useLayoutEffect` in `tug-prompt-entry.tsx` re-seeds the per-card `AtomBytesStore` from durable history atoms (`thumbnailDataUrl` + `path`) and calls `rehydrateDraftAttachments` for the path-bearing ones — this effect survives the rewrite with one change: the marker seed no longer has a persisted thumbnail to offer, so it seeds `{content: "", mediaType: "", path}` and lets rehydration supply pixels.

Keymap recall (`tugdeck/src/components/tugways/tug-text-editor/keymap.ts`, `provider.back/forward`) and the provider cursor/draft contract are untouched by this plan.

**The marker-seeding trap.** The existing re-seed loop puts a bytes-store marker for **every** image atom it finds — `attachmentBytesStore.put(atom.id, {content: "", mediaType: "", thumbnailDataUrl, path})` — and only the *path-bearing* subset goes on to `rehydrateDraftAttachments`. That distinction is load-bearing and easy to lose: the submit gate in `performSubmit` blocks submission of any atom whose `attachmentBytesStore.get(id)` is `null` with a "still processing" banner. If an implementer "simplifies" the loop to seed only path-bearing atoms, every recalled legacy prompt carrying a pathless image atom becomes permanently unsubmittable. Under [P03] the only change to this loop is that `thumbnailDataUrl` is no longer available to pass — the marker is still written for every image atom, and `buildWirePayload` still reads empty `content` as "preview-only" so the prompt ships a mention marker rather than nothing.

#### Cross-instance interaction of a shared ledger with per-instance attachments {#cross-instance-gc}

`draft-attachments/` is **per-instance** (`instance::data_dir()/draft-attachments`), while the ledger is machine-global ([P02]). So each instance's `draft_gc` sweep reads a root set containing UUIDs from *every* instance while sweeping only its *own* directory. The effect is strictly more retention — a UUID that cannot possibly name a local file simply never matches a local filename, and a local file referenced by any instance's history is retained. That is the safe direction, and it is the same direction the module's existing substring predicate already errs in. No instance can delete another's bytes, because no instance sweeps another's directory.

Note also (pre-existing, unchanged here) that the Overview composer uploads into `draft-attachments/` while its durable references land under `overview-attachments/`, so those uploads are collected after the 7-day grace — correct behavior, but it means the directory has two writers and one reachability producer. Worth naming in the docblock touched by #step-4.

#### Law cross-check {#law-cross-check}

- **[L02]** — external state enters React through `useSyncExternalStore` only. Honored: the reshaped `PromptHistoryStore` keeps its `subscribe`/`getSnapshot` pair and the window/`hasMore`/in-flight state is read through it (#state-zone-mapping). The append outbox is module state in `prompt-history-api.ts` that no render ever reads, so it is outside the law's surface rather than an exception to it.
- **[L22] / [L24]** — store→store wiring happens in the store layer, not via a `useSyncExternalStore`→`useEffect` round trip. Honored: the atom-path backfill subscribes to `AtomBytesStore` directly and mutates the history store in the callback, exactly as the existing re-seed effect does.
- **[L29]** — every persisted or compared path routes through the canonicalization gateway. No new exposure: the `path` written to `atoms_json` is **server-minted** by tugcast's own `POST /api/attachments` (built from `draft_attachments_dir()`), is never user-spelled, and is never compared — `draft_gc` matches UUID stems and performs no path comparison at all, by explicit doctrine. This is the same path durable card state already persists. The one caveat: `project_path` is `""` in every live row observed and nothing reads it; if a future feature populates it, that value **must** come through the L29 gateway (`POST /api/fs/stat` → `canonicalizeDirPath`) before being persisted or matched.
- **[L31]** — a gesture produces the act or a visible reason, never silence. This is the law the plan initially violated: a failed append had no user-visible consequence. Addressed in Spec S04 (exhausted retries and an unopenable ledger surface a card notice).
- **[L23]** — durable state survives reload and quit. Honored and strengthened: the ledger is the durable home, and `flushPromptHistorySync` covers the quit boundary.

#### The pathless-atom race and its backfill {#pathless-atom-race}

Image uploads are fire-and-forget at drop time (`tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts`: `void uploadDraftAttachment(file).then(path => …)` merges the path into the bytes-store entry when it lands). A submit that beats the upload writes a history atom with no `path` — permanently unresubmittable and, under [P03], permanently preview-less. All 10 image atoms in the live release bank are pathless (they predate path persistence, commit `4888b9991`).

Fix (#step-6): at the Claude submit site, for each image atom whose bytes-store entry lacks `path`, register a one-shot subscription on the per-card `AtomBytesStore`; when the entry gains a path, call `promptHistoryStore.patchAtomPath(sessionId, clientEntryId, atomId, path)`, which updates the in-memory entry and POSTs `/api/prompt-history/atom-path`. Server-side the handler parses `atoms_json`, sets `path` on the matching atom `id`, and rewrites the row — the one narrow update the append-only store permits, because it completes a record rather than mutating history. If the card closes before the upload resolves, the entry stays pathless — exactly today's behavior, now explicitly bounded to that one edge.

#### Why the migration must precede `defaults_feed` and the sweep {#startup-ordering}

Current `main.rs` startup order: orphaned-history prune → `draft_gc::sweep_at_startup(bank)` → `defaults_feed(client)`. The new order in #step-4/#step-5: open prompt ledger → **migrate tugbank domain into it** → `sweep_at_startup(bank, ledger)` (root set now includes the ledger, so references that just moved remain visible) → `defaults_feed` (first frame already domain-free). The prune block is deleted. Every arrangement where the sweep runs between "references left tugbank" and "sweep reads the ledger" is thereby unrepresentable in the code, which is what "avoid the landmine completely" means.

---

### Specification {#specification}

#### Schema {#schema}

**Spec S01: `prompt_history.db` schema (v1)** {#s01-schema}

```sql
PRAGMA user_version = 1;  -- set by the v1 migration registered in prompt_ledger.rs

CREATE TABLE IF NOT EXISTS prompt_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT    NOT NULL,   -- tugSessionId (stable across --resume)
    route            TEXT    NOT NULL,   -- composer route glyph ("❯", "$", …)
    text             TEXT    NOT NULL,
    atoms_json       TEXT    NOT NULL,   -- JSON array of reference-only atoms [P03]
    project_path     TEXT    NOT NULL,
    submitted_at_ms  INTEGER NOT NULL,
    client_entry_id  TEXT    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_prompt_history_session
    ON prompt_history(session_id, id);
```

Schema evolution: a module-local `PROMPT_HISTORY_SCHEMA_VERSION` constant and a registered-migration list gated on `PRAGMA user_version` (the shared-DB regime, per [P02]) — the miniature of the `CHANGES_SCHEMA_VERSION` regime in `session_ledger.rs`, not the per-instance self-healing regime.

**Deliberately not replicated:** `changes.db` additionally keeps a plaintext **schema sidecar** file (`read_changes_schema_sidecar`) because a *corrupt* database's `user_version` is unreadable, and its downgrade guard must still refuse writes in that state. That hardening exists for a ledger where an older build writing newer shared tables would corrupt attribution truth. Prompt history has no such cross-build write hazard (an append is a standalone row), so the plain `PRAGMA user_version` gate is the whole mechanism — do not build the sidecar, and do not omit the gate.

#### Wire contract {#wire-contract}

**Spec S02: HTTP routes** {#s02-routes}

All three routes are loopback-gated (403 `{"error":"denied"}` otherwise, per the `post_attachments` precedent) and registered in `server.rs`'s route table.

`POST /api/prompt-history` — body `{session_id, route, text, atoms, project_path, submitted_at_ms, client_entry_id}` where `atoms` is the reference-only array. Insert `ON CONFLICT(client_entry_id) DO NOTHING`; respond `200 {"id": <i64>}` with the new or pre-existing row id. `400` on malformed body; `500` on storage failure.

`GET /api/prompt-history?session=<id>&before=<i64?>&limit=<n?>` — keyset page, newest-backward: `WHERE session_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3+1`, probe row popped for `has_more`, entries returned **ascending**. Response `200 {"entries":[Row…], "has_more": bool, "before": <echoed|null>}` where `Row` = `{id, session_id, route, text, atoms, project_path, submitted_at_ms, client_entry_id}` (`atoms` parsed back to an array). Default limit 200; `limit` clamped to [1, 500].

`POST /api/prompt-history/atom-path` — body `{client_entry_id, atom_id, path}`; sets `path` on the matching atom in `atoms_json` (#pathless-atom-race). `200 {"ok":true}`; no-op `200` when the entry or atom is absent (the backfill is best-effort by design).

#### Client contract {#client-contract}

**Spec S03: persisted atom shape** {#s03-atom-shape}

`SerializedAtom` becomes `{position, type, label, value, id?, path?}`. The `thumbnailDataUrl` field is deleted from the interface, from the append serialization in `performSubmit`, and from the recall re-seed. `path` semantics unchanged (absolute path of the stored original; what makes recall resubmittable).

**Spec S04: `prompt-history-api.ts`** {#s04-client-api}

- `appendPromptHistory(entry): Promise<number | null>` — POST with retry outbox: on failure, queue and retry with backoff (1 s, 5 s, 30 s, then per-minute); resolved id is patched onto the in-memory entry (needed by the atom-path backfill and available for future features).
- **Ordering is strictly serialized per session.** Recall order is ledger `id` order, so `id` order must equal submit order. A queued append blocks every later append *for that same session* until it lands — otherwise a failed prompt A retrying while prompt B succeeds gives B the lower id and recall shows them inverted. Different sessions drain independently. `submitted_at_ms` is carried for display and forensics, never for ordering.
- **Exhausted retries are visible, never silent [L31].** After the ladder is exhausted (or when the routes are absent because the ledger failed to open — #step-3), the failure surfaces as a card-visible notice naming the prompt that did not persist; the store must not report a corpus it failed to write. A submit whose durability quietly failed is exactly the "silence is not a neutral outcome" failure L31 was written from, and this feature's whole premise is that prompts are never lost without the user knowing.
- `flushPromptHistorySync()` — synchronous XHR drain of the outbox, called from `DeckManager.teardownSave` in `tugdeck/src/deck-manager.ts` (the two `{ sync: true }` call sites), beside the existing `putCardState(..., { sync: true })`.
- `fetchPromptHistoryPage(sessionId, before?, limit?)` — thin fetch wrapper returning `{entries, hasMore, before}`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| per-session entry window + `hasMore` + page-fetch in-flight flag | structure | `PromptHistoryStore` + `useSyncExternalStore` (existing store, reshaped) | [L02] |
| append outbox (pending POSTs) | structure (non-rendered) | module state in `prompt-history-api.ts`; never enters React | [L02] n/a — no render reads it |
| provider cursor + draft | local to provider object (unchanged) | plain fields on `RouteHistoryProvider` | — |
| atom-path backfill subscriptions | structure | store→store wiring via `AtomBytesStore.subscribe` in `tug-prompt-entry.tsx`, mirroring the existing re-seed effect | [L22], [L24] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/prompt_ledger.rs` | Ledger: open/schema/append/page/atom-path/import + unit tests |
| `tugrust/crates/tugcast/src/prompt_history_api.rs` | Axum handlers for the three routes (Spec S02) |
| `tugdeck/src/lib/prompt-history-api.ts` | Append outbox + page fetch + sync flush (Spec S04) |
| `tests/app-test/at0437-prompt-history-ledger.test.ts` | Submit → relaunch → full-corpus recall |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ENV_PROMPT_HISTORY_DB`, `prompt_history_db_path()` | const, fn | `tugrust/crates/tugcore/src/instance.rs` | mirrors `ENV_CHANGES_DB`/`changes_db_path` [P02] |
| `PromptLedger` (`open`, `open_in_memory`, `append`, `list_page`, `set_atom_path`, `atoms_json_with_refs`, `import_tugbank_entries`) | struct + fns | `prompt_ledger.rs` | open follows `ShellLedger::open` (integrity gate → `ledger_db::open` → salvage with `&["prompt_history"]`) |
| `sweep_at_startup(bank, prompt_ledger: Option<&PromptLedger>)` | fn (modified) | `tugrust/crates/tugcast/src/draft_gc.rs` | ledger unreadable/absent → skip sweep [P04] |
| `migrate_prompt_history(bank, ledger)` | fn | `prompt_ledger.rs` | import-verify-delete per key [P07] |
| `PromptHistoryStore` (rewritten: `push`, `loadSession`→first page, `extendOlder`, `patchAtomPath`; `truncateSession` deleted) | class | `tugdeck/src/lib/prompt-history-store.ts` | [P06], [P08] |
| `putPromptHistory`, `getPromptHistory`, `boundPromptHistoryForPersist`, `MAX_PERSISTED_THUMBNAILS`, `MAX_PROMPT_HISTORY_BYTES` | deletions | `tugdeck/src/settings-api.ts` | retirement |
| `MAX_ENTRIES_PER_SESSION`, `truncateSession` | deletions | `tugdeck/src/lib/prompt-history-store.ts` | [P06], [P08] |
| `prune_orphaned_session_keys` + `test_prune_orphaned_session_keys` | deletions | `tugrust/crates/tugcast/src/defaults.rs` | must go with its only caller or `-D warnings` fails the build (#step-5) |
| `TUG_PROMPT_HISTORY_DB: …` env line | harness env | `tests/app-test/_harness/index.ts` | beside the existing `TUG_CHANGES_DB` line |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `draft_gc.rs`'s module docblock root-set contract to name the ledger as the third root (and note the Overview-composer second-writer observation while in there).
- [ ] Update the `feeds/defaults.rs` shed test to use a synthetic bloated domain name instead of the retired `dev.tugtool.prompt.history` exemplar.
- [ ] Note the new DB in `CLAUDE.md`'s ledger section (`just db-inspect prompt_history …` works unchanged; never open live with sqlite3).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Ledger append/page/idempotence/atom-path; migration import-verify-delete; GC root-set retention; schema-version gate | `prompt_ledger.rs`, `draft_gc.rs` in-memory DBs |
| **Unit (deck)** | Store window/paging/edge-fetch; outbox retry; reference-only serialization | bun tests beside the modules |
| **Integration (app-test)** | Real app, real relaunch, real recall | at0437 |
| **Drift prevention** | `no_ad_hoc_ledger_opens`, `no_ad_hoc_data_dir_resolution` keep passing | existing tests, no changes needed beyond compliance |

#### What stays out of tests {#test-non-goals}

- Rendered recall pixels (thumbnail re-bake visuals) — the rehydration path is already pinned end-to-end by `tests/app-test/at0413-attachment-durability.test.ts`; re-testing it here duplicates coverage.
- Mock-store assertion tests and fake-DOM render tests — banned patterns; deck store tests drive the real store against a stubbed fetch layer only at the network seam.
- Multi-process concurrent-writer stress — WAL + busy_timeout is the platform guarantee; a nondeterministic stress test buys brittleness, not proof.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Path plumbing in tugcore::instance | pending | — |
| #step-2 | PromptLedger module with schema + unit tests | pending | — |
| #step-3 | HTTP routes on tugcast | pending | — |
| #step-4 | GC root-set extension + tugbank migration (one commit) | pending | — |
| #step-5 | Startup wiring and prune retirement | pending | — |
| #step-6 | Client rewrite: paged store, outbox, reference-only atoms, backfill | pending | — |
| #step-7 | Retire the old persistence surface | pending | — |
| #step-8 | App-test at0437 + harness isolation | pending | — |
| #step-9 | Integration checkpoint | pending | — |

#### Step 1: Path plumbing in tugcore::instance {#step-1}

**Commit:** `tugcore(prompt-ledger): machine-global prompt_history.db path with test override`

**References:** [P02] Machine-global ledger, (#constraints, #symbols)

**Artifacts:**
- `ENV_PROMPT_HISTORY_DB` const and `prompt_history_db_path() -> PathBuf` in `tugrust/crates/tugcore/src/instance.rs`.

**Tasks:**
- [ ] Add the const + fn mirroring `changes_db_path` exactly: env override (non-empty) → `guard_isolated(PathBuf::from(p))`, else `guard_isolated(base_data_dir().join("prompt_history.db"))`, with a docblock stating the machine-global rationale in the same voice as `changes_db_path`'s.
- [ ] Add a unit test beside the existing instance-path tests asserting the default path and the override.

**Tests:**
- [ ] `prompt_history_db_path` default + `TUG_PROMPT_HISTORY_DB` override unit test.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`

---

#### Step 2: PromptLedger module with schema + unit tests {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(prompt-ledger): append-only prompt_history.db ledger with keyset paging`

**References:** [P01] Ledger not tugbank, [P02] Machine-global, [P05] HTTP contract (storage half), Spec S01, (#schema, #current-topology)

**Artifacts:**
- `tugrust/crates/tugcast/src/prompt_ledger.rs` with `PromptLedger`: `open` (integrity gate → `tugcore::ledger_db::open` → salvage into `&["prompt_history"]`, per the `ShellLedger::open` pattern), `open_in_memory` (tests), the `user_version`-gated v1 schema (Spec S01), `append(NewPromptEntry) -> id` (`INSERT ... ON CONFLICT(client_entry_id) DO NOTHING` + id lookup on conflict), `list_page(session_id, before: Option<i64>, limit) -> (Vec<PromptRow>, bool)` (keyset, `limit+1` probe, ascending result), `set_atom_path(client_entry_id, atom_id, path)` (parse `atoms_json`, set `path` on matching atom `id`, rewrite), and `atoms_json_with_refs() -> Vec<String>` (`WHERE atoms_json != '[]'`).
- `mod prompt_ledger;` registered in `main.rs`'s module list.

**Tasks:**
- [ ] Write the module; `PromptRow` derives `Serialize` with snake_case wire keys.
- [ ] Schema-version regime: `PROMPT_HISTORY_SCHEMA_VERSION = 1`, migration list applied under the ledger mutex at open; opening a newer-versioned DB is a hard error (warn + ledger absent), never a silent downgrade write.

**Tests:**
- [ ] append assigns ids monotonically; duplicate `client_entry_id` returns the original id and inserts nothing.
- [ ] `list_page`: full-session ascending page, `has_more` probe correctness across page boundaries, `before` cursor exclusivity.
- [ ] `set_atom_path` sets exactly the matching atom; absent entry/atom is a no-op `Ok`.
- [ ] `atoms_json_with_refs` returns only rows with non-empty atom arrays.
- [ ] `user_version` gate: fresh DB lands at 1; a DB stamped 999 refuses to open.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast prompt_ledger`
- [ ] `cd tugrust && cargo nextest run -p tugcore ledger_db` (the `no_ad_hoc_ledger_opens` scan still passes)

---

#### Step 3: HTTP routes on tugcast {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(prompt-ledger): loopback-gated append and page routes`

**References:** [P05] HTTP contract, Spec S02, (#wire-contract)

**Artifacts:**
- `tugrust/crates/tugcast/src/prompt_history_api.rs`: `post_prompt_history`, `get_prompt_history`, `post_atom_path` handlers over an `Extension<Arc<PromptLedger>>`.
- Route registrations in `server.rs`'s route table; ledger `Extension` layered conditionally like the `bank_store` defaults block (routes absent when the ledger failed to open — see Spec S04's [L31] clause for what the client must then show; it must not fail silently).
- A third `Option<Arc<PromptLedger>>` parameter on **both** `build_app` and `run_server` in `server.rs` (they mirror each other's signature, and `run_server` forwards to `build_app`), plus the `server::run_server(...)` call site in `main.rs`.

**Tasks:**
- [ ] Implement the three handlers per Spec S02, loopback-gated via `ConnectInfo<SocketAddr>` + `addr.ip().is_loopback()` per the `post_attachments` precedent; limit clamped to [1, 500], default 200.
- [ ] `mod prompt_history_api;` in `main.rs`; thread the `Arc<PromptLedger>` through the three signatures named in Artifacts. No `DefaultBodyLimit` layer is needed — the JSON bodies are small and axum's 2 MB default is ample now that no base64 rides in an atom ([P03]).

**Tests:**
- [ ] Pure-logic tests over the request→ledger seam against an in-memory ledger: append maps body→row and returns the id; duplicate `client_entry_id` echoes the original id; page request maps cursor/limit and clamps out-of-range limits; malformed body is rejected.

**Note on test layering:** do **not** introduce `tower::ServiceExt::oneshot` handler tests. No axum handler in tugcast is tested that way today — every `oneshot` in the crate is `tokio::sync::oneshot` (a channel) — and `attachments.rs` establishes the convention this plan follows: unit-test the pure helpers, and prove the HTTP contract (status codes, loopback refusal, JSON shapes) end-to-end through the real app, as `at0413` does for attachments and `at0437` does here (#step-8). Growing a new in-crate HTTP test idiom for three routes is the parallel-machinery smell, not thoroughness.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast prompt_history`

---

#### Step 4: GC root-set extension + tugbank migration (one commit) {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(prompt-ledger): ledger joins the draft-gc root set; tugbank history migrates in and the domain retires`

**References:** [P04] GC root set, [P07] Migration, Risk R01, (#startup-ordering, #r01-gc-root-set)

**Artifacts:**
- `draft_gc::sweep_at_startup(bank, prompt_ledger: Option<&PromptLedger>)`: appends `ledger.atoms_json_with_refs()` to `root_json`; `None` or a query error → warn + return without sweeping (retain-everything).
- `migrate_prompt_history(bank: &TugbankClient, ledger: &PromptLedger) -> usize` in `prompt_ledger.rs`: for each key in `PROMPT_HISTORY_DOMAIN`, parse `HistoryEntry[]` (legacy shape: `id`→`client_entry_id`, `timestamp`→`submitted_at_ms`, `sessionId`/`projectPath`/`route`/`text`/`atoms`), strip `thumbnailDataUrl` from each atom, append all, verify every `client_entry_id` exists in the ledger, then delete the tugbank key; parse/verify failure leaves the key with a `warn!`.
- Updated `draft_gc.rs` module docblock naming the third root ([P04], #documentation-plan).

**Tasks:**
- [ ] Implement both; `PROMPT_HISTORY_DOMAIN` stays `pub(crate)` in `defaults.rs` for the migration's use (it is deleted only after the deprecation window in #step-7's docs task — the constant itself remains as the migration's key).
- [ ] Keep the UUID-stem predicate and no-path-comparison doctrine untouched — the extension only adds strings to `root_json`.

**Tests:**
- [ ] Sweep retains a file whose UUID appears only in a ledger row's `atoms_json`; still deletes an aged unreferenced file; skips the sweep entirely when the ledger handle is `None`.
- [ ] Migration: legacy JSON (including a thumbnail-bearing atom) imports with the thumbnail stripped and the key deleted; a second run is a no-op; a malformed key survives with its neighbors migrated; entries landed under the correct sessions.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast draft_gc prompt_ledger`

---

#### Step 5: Startup wiring and prune retirement {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugcast(prompt-ledger): open at startup, migrate before the boot frame, retire the history prune`

**References:** [P01], [P07], (#startup-ordering)

**Artifacts:**
- `main.rs` startup sequence: open `PromptLedger` at `instance::prompt_history_db_path()` (non-fatal: `warn!` and `None` on failure, with `create_dir_all` on the parent, per the `ShellLedger::open` block in `main.rs`) → `migrate_prompt_history(bank, ledger)` when both exist → `sweep_at_startup(bank, ledger.as_deref())` → `defaults_feed(...)` unchanged after it.
- The `prune_orphaned_session_keys(bank, PROMPT_HISTORY_DOMAIN, …)` block in `main.rs` deleted, **and the function itself plus its unit tests deleted from `defaults.rs`** ([P07] implications).
- Updated shed test in `feeds/defaults.rs` using a synthetic domain name (#documentation-plan).

**Tasks:**
- [ ] Wire the ledger `Arc` through to `run_server` (#step-3's parameter). Do **not** hand it to the supervisor — the routes are the only consumer, and `set_shell_ledger`-style injection would grow an unused seam.
- [ ] **Delete `prune_orphaned_session_keys` from `defaults.rs` along with its `test_prune_orphaned_session_keys` test.** `main.rs`'s call is its only non-test caller, so deleting just the call leaves a `pub(crate)` function nothing invokes — and the workspace builds with `-D warnings`, so the resulting `dead_code` warning is a hard build failure, not a lint nit. Removing the tests also retires the last in-crate use of `PROMPT_HISTORY_DOMAIN` outside the migration and the GC root loop.
- [ ] Update the comment above the draft-attachments sweep in `main.rs` that currently explains the sweep runs *after* the prune ("so a swept history key has already released whatever it was holding") — that ordering rationale dies with the prune and is replaced by the migration-before-sweep rationale (#startup-ordering).

**Tests:**
- [ ] Existing tugcast suite passes; migration/sweep tests from #step-4 cover the logic — this step's own proof is the checkpoint run plus a manual launch log check (`imported prompt-history entries` on first launch, absent on second, no prune line).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just build-app` succeeds

---

#### Step 6: Client rewrite: paged store, outbox, reference-only atoms, backfill {#step-6}

**Depends on:** #step-5

<!-- #step-5, not #step-3: Step 3 only threads the ledger *parameter* into the router,
     and Step 5 is what actually opens the ledger in main.rs. Without Step 5 the
     Extension is None, the routes are never registered, and every append 404s — so
     this step could not be verified until a later step landed. -->

**Verifiability precondition:** the routes must be live before this step can be checked, which is why it depends on #step-5 (which opens the ledger) rather than #step-3 (which only threads the parameter). With the ledger unopened, the `Extension` is `None`, the routes are unregistered, and every append 404s into the retry ladder.

**Commit:** `tugdeck(prompt-ledger): history store pages the ledger; appends survive failures; atoms persist as references`

**References:** [P03] References not pixels, [P05] HTTP contract, [P06] Rewind keeps history, [P08] Window model, Spec S03, Spec S04, (#client-contract, #pathless-atom-race, #current-topology, #state-zone-mapping)

**Artifacts:**
- New `tugdeck/src/lib/prompt-history-api.ts` (Spec S04).
- Rewritten `tugdeck/src/lib/prompt-history-store.ts`: window model ([P08]); `push` appends locally + `appendPromptHistory` (resolved ledger id patched onto the entry); `loadSession` fetches the first page; `extendOlder(sessionId)` fetches backward (single-flight per session); `patchAtomPath`; `truncateSession` **deleted**; `SerializedAtom.thumbnailDataUrl` deleted (Spec S03); providers changed only in the window-edge `back()` behavior ([P08]).
- `tug-prompt-entry.tsx`: the four `push` sites serialize reference-only atoms; the Claude submit site registers the one-shot bytes-store backfill subscription for pathless image atoms (#pathless-atom-race); the recall re-seed effect drops `thumbnailDataUrl` from the marker it writes and otherwise keeps its current shape.
- `session-card.tsx`: the `/rewind` truncation effect deleted ([P06]).
- Quit path: `flushPromptHistorySync()` called in `DeckManager.teardownSave` (`tugdeck/src/deck-manager.ts`) beside the existing `putCardState(..., { sync: true })`.

**Tasks:**
- [ ] Implement; delete the `MAX_ENTRIES_PER_SESSION` cap logic outright.
- [ ] `back()` kicks `extendOlder` whenever it cannot advance within its route filter **and** `hasMore` is true — including when the route has zero entries in the window. Do not preserve the bare `if (entries.length === 0) return null;` early return; it is what makes route starvation permanent ([P08] implications).
- [ ] Keep writing a bytes-store marker for **every** image atom in the re-seed loop, path-bearing or not. Seeding only path-bearing atoms leaves `attachmentBytesStore.get(id) === null` for legacy atoms, and the submit gate then blocks the recalled prompt forever with "still processing" (#current-topology, the marker-seeding trap).
- [ ] Surface the exhausted-retry / routes-absent failure as a visible card notice ([L31], Spec S04) — no quiet `catch` that drops the prompt.
- [ ] Update the existing store/keymap tests: window paging (edge press kicks fetch and returns null, post-arrival press lands; zero-route-entries case included), per-session append serialization under a failing first append, reference-only serialization, backfill patch; delete truncation tests with the feature.

**Tests:**
- [ ] `bun test` for `prompt-history-store` and `prompt-history-api`, driving the real store and asserting observable snapshot state; `fetch` is stubbed at the network seam and nowhere else.
- [ ] Ordering test: an append that fails and retries does not let a later same-session append take a lower id (Spec S04).
- [ ] Existing `keymap-arrow-history` tests still pass (provider `back`/`forward` contract unchanged).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 7: Retire the old persistence surface {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(prompt-ledger): retire tugbank history persistence and every cap it forced`

**References:** [P01], [P03], (#context, #documentation-plan)

**Artifacts:**
- Deleted from `tugdeck/src/settings-api.ts`: `putPromptHistory`, `getPromptHistory`, `boundPromptHistoryForPersist`, `MAX_PERSISTED_THUMBNAILS`, `MAX_PROMPT_HISTORY_BYTES`, and their tests in `tugdeck/src/__tests__/settings-api.test.ts`.
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry-strip-and-migrate.test.ts` updated: cap-behavior cases deleted, reference-only serialization cases remain/move per #step-6.
- `CLAUDE.md` ledger-section note (#documentation-plan).

**Tasks:**
- [ ] Delete; `grep -rn "prompt.history" tugdeck/src` afterward must show only `prompt-history-api.ts` route strings — no `/api/defaults/dev.tugtool.prompt.history` reference anywhere.
- [ ] Rust side: confirm the only remaining `PROMPT_HISTORY_DOMAIN` consumers are the migration and the (legacy-reading) draft-gc root loop, both intentional.

**Tests:**
- [ ] Full deck test suite; tsc/vite build clean.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `cd tugrust && cargo nextest run`

---

#### Step 8: App-test at0437 + harness isolation {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `app-test(prompt-ledger): at0437 proves the corpus survives relaunch uncapped`

**References:** [P01], [P05], [P08], Spec S02, (#success-criteria, #test-categories)

**Artifacts:**
- `tests/app-test/_harness/index.ts`: `TUG_PROMPT_HISTORY_DB: …/instances/${instanceId}/prompt_history.db` beside the existing `TUG_CHANGES_DB` line.
- `tests/app-test/at0437-prompt-history-ledger.test.ts` with `@covers` lines naming `tugrust/crates/tugcast/src/prompt_ledger.rs`, `tugrust/crates/tugcast/src/prompt_history_api.rs`, `tugdeck/src/lib/prompt-history-store.ts`, `tugdeck/src/lib/prompt-history-api.ts`.

**Tasks:**
- [ ] Test body: launch, submit a batch of distinct prompts (enough to cross a page boundary against a small test-time page limit is not needed — assert count fidelity, not paging UI), quit, relaunch, assert (a) the recall store reports the full corpus for the session via the page API (`GET /api/prompt-history?session=…` returns every submitted prompt in order), (b) Up-arrow recalls the newest submitted prompt in the composer, (c) `/api/defaults/dev.tugtool.prompt.history` carries no data for the session (domain retired).
- [ ] `just app-test-covers-check` passes.
- [ ] Rust change is in the app bundle: `just build-app` before the test run (app-test never rebuilds the binary).

**Tests:**
- [ ] at0437 green.

**Checkpoint:**
- [ ] `just build-app && just app-test tests/app-test/at0437-prompt-history-ledger.test.ts`
- [ ] `just app-test-changed`

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-8

**Commit:** `N/A (verification only)`

**References:** [P01]–[P08], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify the full flow on the debug instance: launch (migration log line on first launch, absent on second), submit prompts incl. an image drop, relaunch, recall with preview re-bake, arrow past the first page on a long-history session.
- [ ] Confirm the boot DEFAULTS frame shrank (no `dev.tugtool.prompt.history` in `/api/defaults` domain list) and no shed warnings reference it.

**Tests:**
- [ ] Aggregate: `cd tugrust && cargo nextest run` + `cd tugdeck && bun test && bunx vite build` + at0437.

**Checkpoint:**
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Prompt history stored complete and forever in a machine-global append-only ledger, fetched lazily per session, with tugbank carrying zero history bytes and every legacy cap deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No code path can discard a submitted prompt: no entry cap, no byte cap, no thumbnail trim, no rewind truncate, no orphan prune (grep-verified deletions per #step-7).
- [ ] `dev.tugtool.prompt.history` holds zero entries after one launch of each instance (migration verified by at0437 and the #step-4 unit tests; the empty domain row itself persists — see #success-criteria).
- [ ] `draft_gc` sees ledger references (unit test) — no attachment loss window exists in any commit of the sequence (Risk R01).
- [ ] History costs launch nothing: no history fetch occurs before first composer mount (store test: no fetch on construction without a provider).
- [ ] at0437 green; `cargo nextest run` green; `bunx vite build` green; `just app-test-changed` green.

**Acceptance tests:**
- [ ] at0437 (submit → relaunch → full corpus).
- [ ] `prompt_ledger.rs` unit suite (append idempotence, paging, migration, GC root set).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] JSONL recovery of prompts the old caps destroyed before the ledger existed ([P09] settled this out of the current phase, not out of the future).
- [ ] FTS5 index over `text` for prompt-corpus search.
- [ ] Cross-session / cross-project recall surfaces (the machine-global corpus already supports them).
- [ ] Ledger-backed durable card-state attachments audit (the Overview-composer second-writer note in `draft_gc.rs`).

| Checkpoint | Verification |
|------------|--------------|
| Rust suite | `cd tugrust && cargo nextest run` |
| Deck suite + bundle | `cd tugdeck && bun test && bunx vite build` |
| End-to-end | `just build-app && just app-test tests/app-test/at0437-prompt-history-ledger.test.ts` |
| Selection sweep | `just app-test-changed` |
