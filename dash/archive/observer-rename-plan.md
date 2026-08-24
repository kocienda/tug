## The Observer rename — Gazette becomes Overview, Reporter becomes Observer {#observer-rename}

**Purpose:** Rename the app's narration channel from **Gazette** to **Overview** and its summarizing voice from **Reporter** to **Observer**, everywhere — code, wire vocabulary, agent verbs, stored data, UI words, chord, tests, and laws — so no spelling of the retired names survives outside historical roadmap archives.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, opus.** Reviewed `plan:03f551873094f6a2`. Lint: 0 errors, 1 warning (the absent Review Record this paragraph resolves).
Oriented on: the plan as authored this session, read against the code it names.
Applied: **technical choice** — the plan proposed writing a new `componentId` rewrite in `deck-manager.ts`'s load path, but `serialization.ts` already ships `migrateComponentId`, whose docblock states this exact purpose and which already carries a `"dev"` → `"session"` entry from the Session card's own rename; it runs inside `deserialize`, upstream of `filterDeckStateByRegistration`, so the ordering constraint the plan worried about is satisfied by construction. [P04](#p04-layout-migration) was rewritten to extend the existing map, the State Zone Mapping and symbol inventory follow it, and the consequence was carried through — that entry is *permanent* rename history rather than a deletable migration, so [Spec S04](#s04-vestige-boundary), the exit criteria, and the follow-on list now distinguish two deletable migrations from one permanent map entry. **Falsifiability** — the success criterion "the grep returns only sanctioned migrations" was unsatisfiable as written, because `vite.config.ts` uses "reporter" for Vite's own build reporter; the boundary now names that false positive explicitly and [Step 7](#step-7)'s checkpoint states its four expected paths so the criterion can actually be met. **Sequencing hole** — roughly seventy files carry one to six incidental mentions that break no build when missed, and they would have surfaced only at [Step 7](#step-7), which is verification-only and carries no commit, leaving stragglers nowhere to land; [Table T05](#t05-incidental) now enumerates them by layer, each owning step gained a sweep task, and [Step 7](#step-7) says explicitly that a straggler goes back to its owning step. **Coverage** — `tugcast/src/main.rs` holds 46 mentions and no rename of its own and was unnamed in [Step 2](#step-2); it is now called out with its three distinct sites. **Test strength** — [Step 4](#step-4)'s single map test would have passed even if the map were never called, so a second test now drives a real serialized layout through `deserialize` + `filterDeckStateByRegistration` against the real registry, which is what actually proves the rail survives. **Law discipline** — added [#tuglaws-cross-check](#tuglaws-cross-check), naming [L30] as the law most at risk, since [Step 5](#step-5) moves a chord, a menu item id, and a Swift selector at once.
Deferred: nothing. Every design question raised during authoring was asked and settled as [P01](#p01-full-migration)–[P07](#p07-pulse-collision); no `[Q##]` remains.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The narration channel has been called the **Gazette** since it shipped: an app-wide scrolling column of posts written by three voices — the **Reporter** (unbidden digests of session work), the **Operator** (answers to questions the user asks the channel), and the **user**. The names are being retired. *Gazette* is a press metaphor that never earned its keep, and *Reporter* names a job — filing copy — that misdescribes what the voice does, which is watch. **Overview** and **Observer** replace them. *Operator* is unchanged and stays exactly as it is.

The instruction is a rename "top to tail with no laggards or vestiges," and the investigation behind this plan found that this is not a code-only job. Five surfaces hold the old spellings in **persisted user data**, and each one is a place where a naive find-and-replace either loses data or strands it:

- The `gazette_posts` SQLite table — **3,585 live posts** in the release instance — with an FTS5 external-content index, three sync triggers, an index, and five ALTER-based migrations.
- The `author` column of that table, holding the literal string `'reporter'` in **3,534 of those rows**.
- The card's `componentId: "gazette"`, written into the saved deck layout in tugbank. This one bites: `DeckManager.filterRegisteredCards` **drops any pane whose only card's componentId is unregistered at load**, so renaming the id without a layout migration silently evaporates the user's rail on the first reload after the rename.
- The tugbank defaults domain `dev.tugtool.gazette`, currently holding one key (`widthPx`).
- The scroll-region key `gazette-transcript` in the session-private store.

There is a cautionary precedent in this repository. The Snippets → Jots rename left `snippets.json` orphaned on disk beside `jots.json` with no migration code anywhere — exactly the kind of laggard this pass exists to avoid repeating.

This pass also serves a second purpose, recorded here so a cold reader understands why the plan exists now. [`dash-closure-brief.md`](dash-closure-brief.md#join-hunt) has a standing open item: the Changes shade's join surface was once reported as completely non-functional in real use and was never reproduced. The brief's prescribed resolution is to exercise the join surface deliberately on **real work** and either capture a misbehavior or downgrade the report with the exercise as its receipt. The previous candidate — the unified Changes pass — could not serve, because its own landing was driven by the *pre-rebuild* instance and so never touched the redesigned surface. This rename is the next real piece of work, it is mechanical enough that a mid-dash design crisis cannot muddy the signal, and it is long enough to exercise the whole dash lifecycle including base motion. Its landing is the receipt. **Nothing in this plan implements that; the landing is the user's gesture and the observation is theirs.**

#### Strategy {#strategy}

- **Storage first, and alone.** The ledger migration is the only step that can lose data, so it lands as its own commit with its own tests, before any symbol moves. Everything after it is mechanical.
- **Rename in dependency order, keeping every commit green.** Storage → Rust symbols and wire vocabulary → tugdeck data layer → the card → the words and the chord → tests and goldens. Each step compiles, passes its layer's tests, and is independently revertable.
- **Migrations are not vestiges.** A migration names the old world on purpose; that is its job. The rename is complete when no *live* code path speaks the old names — the two migration functions that mention them are the exception the rule requires, and each carries a note saying when it may be deleted.
- **Derived artifacts are regenerated, never hand-edited.** The imposer golden holds 396 occurrences of the old card id; `just golden` produces it from the code that defines it.
- **The app-test layer moves with its subjects.** Six `at03xx-gazette-*.test.ts` files rename, and every `@covers` line pointing at a renamed source file follows, enforced by `just app-test-covers-check`.
- **Prove the absence, don't assert it.** The final step's checkpoint is a grep over the whole tree that must return nothing outside `dash/archive/` and the two named migrations.

#### Success Criteria (Measurable) {#success-criteria}

- A case-insensitive grep for `gazette` and `reporter` across the repository returns hits **only** in the four categories [Spec S04](#s04-vestige-boundary) enumerates — historical roadmap documents, captured fixtures, the two deletable migrations, and the permanent `migrateComponentId` entry — plus the one unrelated Vite build-reporter comment that spec names explicitly (verified by the [Step 7](#step-7) checkpoint command).
- The live release instance's 3,585 posts are all readable in the Overview card after the migration, and the channel's full-text search still returns hits (verified by running the migration against a **copy** of the real `sessions.db` per [Spec S02](#s02-migration-verification), and by opening the rebuilt app).
- Zero rows in `overview_posts` have `author = 'reporter'`; the count of `author = 'observer'` equals the pre-migration count of `'reporter'` (3,534 in the reference instance).
- The user's Overview rail survives the rename with its pane, side, and width intact — the saved layout's `componentId: "gazette"` is rewritten to `"overview"` before registration filtering (verified by `at0365` and by the unit test in [Step 4](#step-4)).
- ⌃⌘O opens and closes the Overview rail; ⌃⌘G does nothing (verified by `at0365-overview-card.test.ts`).
- An Observer post renders with the lucide `eye` glyph and the row label `Observer` (verified by `at0365`).
- `cargo nextest run`, `bun test`, `bunx tsc --noEmit`, `bunx vite build`, and `just app-test-covers-check` are all clean; the seven-file app-test selection in [Step 7](#step-7) is green.

#### Scope {#scope}

1. The SQLite storage: table, FTS5 index, triggers, index, migrations, and the persisted `author` value.
2. The Rust backend: `tugcast-core` types and feed ids, the four feed modules, the agent verbs, the defaults domain, the model job name, and the CLI/Justfile replay recipe.
3. The tugdeck data layer: `protocol.ts`, the store, and the five `lib/gazette-*.ts` leaf modules.
4. The card: the `components/gazette/` tree, the registry `componentId`, and the saved-layout migration.
5. The words: card title, author label, participant glyph, chord, menu item, Swift handler, slash-command help text.
6. The tests: six renamed app-test files, their `@covers` lines, the unit tests, and the regenerated imposer golden.
7. The laws: the five `tuglaws/*.md` files that name the Gazette.
8. Tightening the few bare `overview` internals in `pulse-store.ts` so the pre-existing pulse concept stays fully qualified.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Renaming the Operator.** It keeps its name, its verbs, and its glyph.
- **Renaming the per-session pulse overview.** `session_overview.rs`, the `pulse_overviews` table, `PulseOverviewEntry`, and `usePulseOverview` keep their names — settled in [P07](#p07-pulse-collision).
- **Any behavior change.** This pass changes what things are called and nothing about what they do. A diff hunk that alters logic is out of scope and belongs in its own change.
- **Rewriting historical data content.** Post *bodies* that mention "the Gazette" or "the Reporter" in prose are the authors' words at the time and are never rewritten; only the structured `author` column changes.
- **Migrating the `gazette-transcript` scroll-region key.** Settled in [P06](#p06-what-migrates) — losing a scroll offset is invisible.
- **Renaming files under `dash/` or `dash/archive/`.** Those are historical documents; they said "Gazette" because that was the name.
- **Closing the Join sheet report.** This plan's landing produces the *evidence*; writing the downgrade is a separate act in `closing-dash-backend-issues-brief.md#join-sheet`.

#### Dependencies / Prerequisites {#dependencies}

- A dash worktree created by `/tugplug:dash-implement`, since the landing is the point (see [#context](#context)).
- The Rust workspace builds under `-D warnings` (`tugrust/.cargo/config.toml`).
- `just golden` is the sanctioned regenerator for `tugdeck/src/lib/__tests__/golden/imposer-solutions.json`; see the `golden` recipe in the `Justfile`.
- A Rust change requires `just build-app` before any app-test can observe it — the app-test harness refreshes `dist` but never rebuilds the binary.

#### Constraints {#constraints}

- **Never point the `sqlite3` CLI at a live database** under `~/Library/Application Support/Tug/`. Use `just db-inspect <name|path> ["SQL"]`, which copies the db plus its WAL/shm to a temp directory and inspects the copy.
- **The app-test corpus does not run from a dash worktree** — the recipe refuses, because every `tugutil dash` verb resolves the *main* repo root. App-test verification therefore happens from the main checkout after the landing; each step's own checkpoint uses the layers that do run on the worktree (`cargo nextest run`, `bun test`, `bunx tsc --noEmit`, `bunx vite build`).
- **`gazette_posts` must never be registered with `rebuild_table_if_schema_drifted`.** That guard resolves a column-set change by dropping and recreating, which is total data loss on a permanent history table. The existing DDL comment says so explicitly; the rename must preserve that warning, retargeted at the new name.
- Warnings are errors in the Rust workspace.
- The feed id **bytes** `0x70` / `0x71` are the wire contract and do not change; only their symbol names and display names do.

#### Assumptions {#assumptions}

- Both halves of the wire (tugcast and tugdeck) ship together in one build, so renaming a control-message action name or a feed's display name breaks no deployed peer. This is how every prior protocol rename in this repo has worked.
- Historical agent transcripts that mention the verbs `gazette.search` / `gazette.window` are inert text; nothing replays a stored transcript back through the verb dispatcher.
- The reference counts in this plan (3,585 posts; 3,534 `'reporter'`) come from the `release-main` instance on 2026-08-16 and will have grown by implementation time. The assertions are written as relationships (nothing lost, nothing left behind), never as literal counts.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. Plan-local decisions are `[P01]`…; `[D##]` refers to the global [design-decisions.md](../tuglaws/design-decisions.md). Steps cite anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

Every design question this plan raised was asked and settled during authoring; the answers are recorded as [P01](#p01-full-migration) through [P07](#p07-pulse-collision). No question remains open.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Ledger migration loses or orphans posts | high | low | Rehearse on a copy of the real db ([Spec S02](#s02-migration-verification)); ALTER/RENAME only, never drop-and-recreate on the base table | Any post-count mismatch on the rehearsal |
| Saved layout drops the rail | med | high without mitigation | Rewrite `componentId` before registration filtering ([P04](#p04-layout-migration)) | The rail is missing after a rebuild |
| FTS5 index left pointing at the old content table | med | med | Drop and recreate the FTS table and triggers, then `'rebuild'` ([Spec S01](#s01-ledger-migration)) | Channel search returns zero hits |
| A rename lands inside a post body or a roadmap document | low | med | Scope every mechanical replacement to code paths; [Spec S04](#s04-vestige-boundary) names the excluded trees | Grep shows a changed `.md` under `dash/` |
| "Overview" collides with the pulse overview | low | certain | The pulse concept is already prefixed at every public boundary; tighten the few bare internals ([P07](#p07-pulse-collision)) | A future reader files an ambiguity bug |

**Risk R01: The migration runs against a live database on first launch** {#r01-live-migration}

- **Risk:** The schema work in [Step 1](#step-1) executes against the user's real `sessions.db` the first time the rebuilt app opens it, on a table that is permanent history with no backup taken by this plan.
- **Mitigation:**
  - Rehearse the exact migration against a `just db-inspect` copy of the real database and assert the invariants in [Spec S02](#s02-migration-verification) before the step is committed.
  - The migration is self-healing and idempotent, following the shape of the existing `migrate_gazette_posts_add_*` helpers: it inspects the schema and no-ops when already migrated or when the table does not exist.
  - The base table is renamed with `ALTER TABLE … RENAME TO`, never recreated. Only the FTS shadow tables — which the DDL comment already declares safe to drop and rebuild freely — are dropped.
- **Residual risk:** A database interrupted mid-migration. SQLite executes the batch in a transaction, so the surviving state is either fully old or fully new; a torn intermediate is not reachable.

**Risk R02: The rename passes through a string that is data, not code** {#r02-data-strings}

- **Risk:** A tree-wide replacement rewrites a post body, a golden fixture's recorded text, or a historical roadmap document.
- **Mitigation:**
  - No step performs an unscoped tree-wide replacement. Each step names its files.
  - The imposer golden is regenerated by `just golden`, never edited.
  - [Spec S04](#s04-vestige-boundary) defines exactly which trees are excluded, and [Step 7](#step-7)'s checkpoint greps with those exclusions.
- **Residual risk:** None material; a wrongly-rewritten roadmap file shows up immediately in `git diff`.

---

### Design Decisions {#design-decisions}

#### [P01] Stored data migrates in full (DECIDED) {#p01-full-migration}

**Decision:** The `gazette_posts` table is renamed to `overview_posts`, its FTS5 index and triggers are recreated under the new names, and every `author = 'reporter'` row is updated to `'observer'`.

**Rationale:**
- The instruction is "no laggards or vestiges," and a schema that says `gazette_posts` is the most durable vestige available — visible to anyone reading the DDL or running `just db-inspect`.
- The alternative considered and rejected was a code-only rename, which is zero-risk but permanent: nothing would ever come back to fix it, exactly as nothing came back for `snippets.json`.
- The risk is bounded and rehearsable: the base table moves by `ALTER TABLE … RENAME TO`, and the only things dropped are the FTS shadow tables the existing DDL comment already declares free to drop and rebuild.

**Implications:**
- A new self-healing migration in `session_ledger.rs` ([Spec S01](#s01-ledger-migration)), which must run **before** the `CREATE TABLE IF NOT EXISTS overview_posts` statement — otherwise the CREATE makes an empty new table and the migration finds nothing to rename.
- The `OverviewAuthor` enum's serde spelling becomes `observer`, so parsing an old un-migrated row would fail at the edge. That is correct and intended: the migration is what makes the rows parseable, and a row that escapes it should be loud rather than silently dropped.

#### [P02] The chord follows the name — ⌃⌘G becomes ⌃⌘O (DECIDED) {#p02-chord-moves}

**Decision:** `TOGGLE_OVERVIEW` binds ⌃⌘O. ⌃⌘G is left unbound.

**Rationale:**
- The sidebar-toggle set is documented in `command-registry.ts` as a grammar that teaches itself: ⌃⌘L Lens, ⌃⌘J Jots, ⌃⌘G Gazette. With the card renamed, ⌃⌘O keeps the mnemonic and ⌃⌘G breaks it.
- ⌃⌘O is currently unbound — the ctrl+meta letters in use are A, C, F, G, H, I, J, K, L, M, P, T, U — so nothing is displaced.

**Implications:**
- `tuglaws/menus.md` has two tables naming ⌃⌘G and `maker.gazette`; both rows change.
- `at0365`'s first claim drives the chord as a real keystroke and must be retargeted, plus a new assertion that ⌃⌘G no longer toggles anything.

#### [P03] The agent verbs rename to `overview.*` (DECIDED) {#p03-agent-verbs}

**Decision:** `gazette.search` and `gazette.window` become `overview.search` and `overview.window`, in the dispatcher, the allowlist, and the instruction prose the agent reads.

**Rationale:**
- The verb names appear verbatim in system prompts, so leaving them teaches the model a word the UI never shows — and that word leaks back into the model's prose, which is how a retired name survives longest.
- Nothing replays historical transcripts through the dispatcher, so stale mentions are inert.

**Implications:**
- `feeds/operator.rs` carries the verb strings in its allowlist, its `match` dispatch, and its error-message formatting; `feeds/overview_agent.rs` carries them in three places in the instruction text, including the closing "every verb you may ask for" list.

#### [P04] The saved layout migrates through the existing rename map (DECIDED) {#p04-layout-migration}

**Decision:** `GAZETTE_CARD_ID = "gazette"` becomes `OVERVIEW_CARD_ID = "overview"`, and the `"gazette"` → `"overview"` mapping is added to the **existing** `migrateComponentId` function in `tugdeck/src/serialization.ts`.

**Rationale:**
- `DeckManager.filterRegisteredCards` drops cards whose componentId is unregistered, and drops any stack left empty as a result. Without a rewrite, the first launch after the rename deletes the user's rail — a data loss disguised as a cosmetic change.
- **This machinery already exists and is already correct.** `serialization.ts` has `migrateComponentId`, whose docblock states its purpose exactly: *"Map a persisted card `componentId` through the kind-rename history so a deck saved before a registry-kind rename still resolves to a registered card."* It already carries one entry — the Session card shipped as `"dev"` and is rewritten to `"session"` — for precisely the reason this plan needs, and it runs inside `deserialize`, which is upstream of `filterDeckStateByRegistration`.
- Writing a second rewrite in `deck-manager.ts`'s load path would grow a parallel mechanism beside a shipping one, and would have to re-derive the ordering constraint that `migrateComponentId`'s placement already guarantees.

**Implications:**
- The change is one map entry plus a docblock sentence, not a new function.
- `migrateComponentId` is a **permanent, growing rename history**, not a temporary migration: the `"dev"` → `"session"` entry has never been deleted and should not be. The `"gazette"` entry joins it on the same terms, which is why [Spec S04](#s04-vestige-boundary) treats it differently from the two migrations that *are* eventually deletable.
- `__tests__/changeset-card-retired.test.ts` is the precedent for testing this layer — it drives `filterDeckStateByRegistration` against the real card registry.

#### [P05] The test surface takes a major version (DECIDED) {#p05-surface-major}

**Decision:** `publishGazettePost` becomes `publishOverviewPost`, and `SURFACE_VERSION` goes from `2.8.0` to `3.0.0`.

**Rationale:**
- The surface's own documented rule, stated in its module docblock at the `2.0.0` entry, is that a removal is breaking and takes the major. Renaming a method removes the old name.

**Implications:**
- The `3.0.0` docblock entry explains the rename, following the format of the existing entries.
- The harness's own surface version in `tests/app-test/_harness/index.ts` is a separate number and does not move.

#### [P06] What migrates and what resets (DECIDED) {#p06-what-migrates}

**Decision:** The post table, the author value, the saved layout, and the `dev.tugtool.gazette` defaults domain all migrate. The `gazette-transcript` scroll-region key does not.

**Rationale:**
- The first four hold something the user would notice losing: their posts, their rail, and the rail's width.
- The scroll key holds a scroll offset inside a card that opens at the bottom anyway. Migrating it would cost code for an effect no user could perceive.

**Implications:**
- The defaults domain becomes `dev.tugtool.overview`, with a one-shot forward-copy of the `widthPx` key on first read ([Spec S03](#s03-defaults-migration)).
- The scroll key simply becomes `overview-transcript`; the old entry is left where it lies and ages out with the rest of the per-session record.

#### [P07] "Overview" stays plain; the pulse concept stays prefixed (DECIDED) {#p07-pulse-collision}

**Decision:** The card takes the plain name **Overview**. The pre-existing per-session pulse overview keeps its name, and the few bare `overview` identifiers inside `pulse-store.ts` are qualified so the distinction is total.

**Rationale:**
- "Overview" already names the per-session pulse line — the one-sentence answer to "what is this session working on?" — via `session_overview.rs`, the `pulse_overviews` table, `PulseOverviewEntry`, `PulseOverviewWireRow`, and `usePulseOverview`. Every one of those is already prefixed, so the two subjects almost never collide in practice.
- The exceptions are internal to `pulse-store.ts`: `foldOverview`, `latestOverviewForScope`, `EMPTY_OVERVIEWS`, and the `overviews` snapshot field. Qualifying them makes the codebase answer to [D123] one name one producer, and costs one small diff in one file.
- Renaming the pulse concept instead was considered and rejected: it is a wider change touching a feed, a table, and two stores, and it deserves its own design round rather than riding along on a rename.

**Implications:**
- `pulse-store.ts` gains `foldPulseOverview`, `latestPulseOverviewForScope`, `EMPTY_PULSE_OVERVIEWS`, and a `pulseOverviews` snapshot field. The `PulseOverviewEntry` type and `usePulseOverview` hook are already correct and do not move.
- After this pass, a bare grep for `overview` still returns two subjects, but every identifier is unambiguous on sight.

---

### Deep Dives {#deep-dives}

#### The five persistence surfaces, and what each one needs {#persistence-surfaces}

**Table T01: Persisted spellings of the retired names** {#t01-persisted}

| Surface | Where it lives | Reference size | Disposition |
|---|---|---|---|
| `gazette_posts` table, index, FTS5 index, 3 triggers | per-instance `sessions.db` | 3,585 rows | Renamed by [Spec S01](#s01-ledger-migration) |
| `author = 'reporter'` | same table's `author` column | 3,534 rows | `UPDATE` to `'observer'` |
| `componentId: "gazette"` | tugbank, deck layout value | 1 card | Rewritten on load, [P04](#p04-layout-migration) |
| `dev.tugtool.gazette` domain | tugbank | 1 key (`widthPx`) | Forward-copied, [Spec S03](#s03-defaults-migration) |
| `gazette-transcript` scroll key | session-private store `regionScroll` | 1 key | Not migrated, [P06](#p06-what-migrates) |

The counts come from the `release-main` instance on 2026-08-16, read through `just db-inspect`. They are context for sizing, not assertions — see [#assumptions](#assumptions).

#### The incidental mentions, and why they get their own tasks {#incidental-mentions}

Roughly seventy files hold between one and six mentions of the retired names — an import, a comment, a docblock sentence, a single string. They are individually trivial and collectively the whole risk of this pass: none of them breaks a build when missed, so nothing fails, and they surface only at the very end when [Step 7](#step-7) runs its grep. [Step 7](#step-7) is verification-only and carries no commit, so a straggler found there would have nowhere to land.

The plan therefore sweeps them **inside the step that owns their layer**, and [Step 7](#step-7)'s grep is a true verification rather than a work-discovery pass. Each sweep task names its layer's boundary so the implementer can enumerate the files with one grep.

**Table T05: Where the incidental mentions live** {#t05-incidental}

| Layer | Owning step | Files with mentions but no rename of their own |
|---|---|---|
| Rust backend | [Step 2](#step-2) | `tugcast/src/main.rs` (46 — feed wiring, the replay dispatch, and the `ReporterBridge` construction), `attachments.rs`, `search_tokens.rs`, `shared_agent.rs`, `session_ledger.rs` prose, `feeds/`: `operator_ask.rs`, `facts_library.rs`, `agent_supervisor.rs`, `base_motion.rs` (which cites `reporter_wake.rs` by name), `mod.rs` |
| tugdeck data layer | [Step 3](#step-3) | `action-dispatch.ts`, `session-private-store.ts`, `session-citation-store.ts`, `card-session-binding-store.ts`, `dash-session-index.ts`, `clipboard-origin.ts`, `attachment-upload.ts`, `annotator/registry.ts`, `annotator/path-resolution.ts`, `layout-imposer.ts` |
| The card and its host | [Step 4](#step-4) | `main.tsx` (the store attach and the card registration), `card-registry.ts`, `deck-canvas.tsx`, `lens/lens-register-card.tsx`, `lens/sections/cards-section.tsx` |
| Words and chrome | [Step 5](#step-5) | `tug-atom-ref.tsx` and `.css`, `tug-sheet.tsx`, `entity-tips.tsx`, `annotation-portals.tsx`, `tug-changes-list.tsx`, `tug-session-identity.tsx` and `.css`, `tug-jump-to-bottom-button.tsx` and `.css`, `tug-attachment-preview.tsx` and `.css`, `transcript-host-helpers.ts`, `middle-ellipsis-path.tsx`, `gallery-*.tsx`, `session-card.tsx`, `tug-text-editor/annotation-links.ts`, `tug-text-editor/clipboard-filters.ts`, `slash-commands.ts` |

`tugdeck/vite.config.ts` is deliberately **absent** from this table: its "reporter" is Vite's build reporter and is not a mention of the retired name. See [Spec S04](#s04-vestige-boundary).

#### The tuglaws cross-check {#tuglaws-cross-check}

A rename touches many laws by passing through their territory without changing anything, which is its own risk: the easiest way to break a law is to move a symbol out from under it. Each law below is named with what this pass does to it.

- **[L30] Every user-invocable command is a registry entry, and every emitter goes through the two funnels.** This is the law most at risk, because [Step 5](#step-5) moves a chord *and* a menu item id *and* a Swift selector. The action must stay a `command-registry.ts` entry carrying its `menuItemId`, and `AppDelegate.swift` must keep dispatching through `sendControl` rather than acting directly. `command-routing-drift.test.ts` is the existing guard and is named in [Step 5](#step-5)'s Tests block for exactly this reason.
- **[L25] Deck → Pane → Card is the canonical canvas hierarchy.** Honored and unchanged: the Overview stays an ordinary registered card hosted by the normal `CardHost` in a sidebar pane. The `family` value changes spelling; the un-mergeable posture (`acceptsFamilies: []`) does not.
- **[L02] External state enters React through `useSyncExternalStore` only.** Honored: `useGazette` becomes `useOverview` with its mechanism untouched, and the layout rewrite ([P04](#p04-layout-migration)) is a pure transform inside deserialization, not a new state source.
- **[L24] State is partitioned into three zones**, and **[L06] ephemeral appearance state goes through CSS and DOM.** The participant glyph change is appearance and lands as an icon-map entry plus a CSS attribute selector keyed on `data-participant="observer"` — no React state. See [#state-zone-mapping](#state-zone-mapping).
- **[L19] Every component follows the component authoring guide.** No new components; the three renamed files keep their structure.
- **[L11] Controls emit actions; responders own state.** Unchanged — the rail toggle still emits `toggle-overview` and the canvas handler still owns the response.
- **[D123] one name one producer.** The one law this pass actively *improves*, via [P07](#p07-pulse-collision): after the rename, `overview` names two subjects, and qualifying the bare pulse internals is what keeps each identifier attributable to exactly one producer.

#### Why the migration must run before the CREATE {#migration-ordering}

`SessionLedger`'s schema routine calls its `migrate_*` helpers and then executes a batch of `CREATE TABLE IF NOT EXISTS` statements. If the new `CREATE TABLE IF NOT EXISTS overview_posts` ran first, it would succeed against a database that still holds `gazette_posts`, producing an **empty** `overview_posts` — and the migration would then find a table already present and no-op, stranding every existing post in an orphaned table nothing reads.

So the rename migration is registered alongside the existing `migrate_gazette_posts_add_*` calls, which already run before the CREATE batch, and it is written to be the first of them. Its guard is the presence of the *old* table, not the absence of the new one.

#### The FTS5 external-content index cannot simply be renamed {#fts-rename}

`gazette_posts_fts` is declared `USING fts5(body, refs, tokens, content='gazette_posts', content_rowid='id')`. The `content=` option is baked into the virtual table's stored definition, so renaming the base table leaves the index pointing at a name that no longer exists. The three sync triggers name both tables in their bodies and have the same problem.

The DDL comment already blesses the fix: *"The FTS5 shadow tables below are the opposite case: they are derived from this table and may be dropped and rebuilt freely."* So the migration drops the triggers and the FTS table, renames the base table, and recreates both under the new names, finishing with FTS5's own rebuild command.

Ordering inside the migration matters for a second reason: the `UPDATE` of 3,534 author rows must happen while **no triggers exist**, or each row fires the update trigger and writes two FTS command rows. Dropping the triggers first makes the update a plain table write, and the subsequent `'rebuild'` regenerates the whole index from the finished content in one pass.

---

### Specification {#specification}

**Spec S01: The ledger rename migration** {#s01-ledger-migration}

A new self-healing function on `SessionLedger`, named `migrate_gazette_posts_to_overview_posts`, registered in the schema routine **before** the `CREATE TABLE IF NOT EXISTS` batch and alongside the existing `migrate_gazette_posts_add_*` calls. It performs, in one transaction:

1. Guard: if `gazette_posts` does not exist (fresh database, or already migrated), return `Ok(())` unchanged.
2. `DROP TRIGGER IF EXISTS` for `gazette_posts_fts_insert`, `gazette_posts_fts_delete`, `gazette_posts_fts_update`.
3. `DROP TABLE IF EXISTS gazette_posts_fts`.
4. `ALTER TABLE gazette_posts RENAME TO overview_posts`.
5. `DROP INDEX IF EXISTS gazette_posts_session`, then create `overview_posts_session` on `overview_posts(session_id)`.
6. `UPDATE overview_posts SET author = 'observer' WHERE author = 'reporter'`.
7. Recreate `overview_posts_fts` with `content='overview_posts'` and the three triggers, matching the DDL the schema routine defines for a fresh database.
8. `INSERT INTO overview_posts_fts(overview_posts_fts) VALUES('rebuild')`.

The function is idempotent: a second run finds no `gazette_posts` and returns at step 1. It is named after what it does and carries a docblock stating it may be deleted once no installation predates the rename — see [Spec S04](#s04-vestige-boundary).

The retargeted DDL keeps the existing warning verbatim, with the new name: `overview_posts` must **never** be registered with `rebuild_table_if_schema_drifted`.

**Spec S02: How the migration is verified before it is trusted** {#s02-migration-verification}

Two layers, both against real data:

- **A Rust test** that builds a database carrying the *old* schema — `gazette_posts` with its FTS5 index and triggers — inserts posts under all three author values, runs the migration, and asserts: the post count is unchanged; no row has `author = 'reporter'`; the `'observer'` count equals the pre-migration `'reporter'` count; `'operator'` and `'user'` rows are untouched; a full-text search through the ledger's own search method returns the expected hit; and a second run of the migration is a no-op. This exercises the real SQLite code path, not a mock.
- **A rehearsal against the real database**, run by hand during [Step 1](#step-1) and reported in the step's checkpoint. Copy the live instance's `sessions.db` with `just db-inspect`, run the migration against the copy, and confirm the same invariants at the reference scale. The live file is never opened by anything but Tug.

**Spec S03: The defaults domain forward-copy** {#s03-defaults-migration}

`GAZETTE_DOMAIN = "dev.tugtool.gazette"` becomes `OVERVIEW_DOMAIN = "dev.tugtool.overview"`. On first read of a key in the new domain that has no value, the reader checks the old domain for the same key, and if it finds one, writes it forward into the new domain and returns it. Only `widthPx` exists today, so the effect is that the user's rail width survives.

Like the layout rewrite, this names the old domain on purpose and is covered by [Spec S04](#s04-vestige-boundary).

**Spec S04: What "no vestiges" excludes** {#s04-vestige-boundary}

The rename is complete when a case-insensitive grep for `gazette` or `reporter` across the repository returns hits only in the following four categories. Everything else is a defect.

1. **`dash/` and `dash/archive/`** — historical documents that said "Gazette" because that was the name. Rewriting them would falsify the record.
2. **`capabilities/`** — captured fixtures of external tool metadata, which are recordings and not source.
3. **The two deletable migrations:** the ledger migration from [Spec S01](#s01-ledger-migration) and the defaults forward-copy from [Spec S03](#s03-defaults-migration). Each carries a docblock line naming the condition under which it may be deleted — once no installation predates the rename.
4. **The permanent rename-history entry** in `migrateComponentId` ([P04](#p04-layout-migration)). Unlike the two above it is *not* slated for deletion: it is one row in a map whose whole purpose is to remember retired componentIds, alongside the `"dev"` → `"session"` entry that has lived there since the Session card was renamed.

**One unrelated English use survives and is not a vestige.** `tugdeck/vite.config.ts` has a comment about *"the default build reporter"* — Vite's asset-table printer, which has nothing to do with the narration voice. It is named here so that a future reader running the grep does not "fix" it, and so the [Step 7](#step-7) checkpoint's expected output is exact rather than approximate. A naive success criterion of "the grep returns nothing" would be unsatisfiable, and a plan whose exit criterion can never be met is worse than one with no exit criterion at all.

The [Step 7](#step-7) checkpoint encodes exactly this boundary as a command, and states the expected surviving hits by file.

#### Terminology and Naming {#terminology}

**Table T02: The rename, term by term** {#t02-terms}

| Retired | Replacement | Notes |
|---|---|---|
| Gazette (the channel, the card, the rail) | **Overview** | Card title, prose, module names |
| Reporter (the summarizing voice) | **Observer** | Author label, participant, feed module |
| Operator | *unchanged* | Both name and glyph stay |
| `Newspaper` (card icon) | *unchanged* | The glyph describes the card's form, not its old name |
| `Newspaper` (reporter participant glyph) | lucide **`Eye`** | The voice that watches |
| ⌃⌘G | ⌃⌘O | [P02](#p02-chord-moves) |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

This pass introduces exactly one new piece of state — the layout rewrite is a pure transform in an existing load path, not stored state. Everything else is a rename of state that already exists and already sits in its correct zone.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Persisted `componentId` rewrite (`"gazette"` → `"overview"`) | structure | one entry in the existing `migrateComponentId` map in `serialization.ts`, applied during `deserialize` and therefore upstream of `filterDeckStateByRegistration`; no new function, no new store, no new React state | [L02] |
| `OverviewStore` snapshot (renamed from `GazetteStore`) | structure | unchanged — store + `useSyncExternalStore` via `useOverview()` | [L02] |
| Participant glyph (`Eye` replacing `Newspaper`) | appearance | unchanged — CSS keyed on `data-participant="observer"` plus the icon map | [L06] |
| Rail width default (domain forward-copy) | local-data | unchanged — tugbank defaults, never Web storage | [L24] |

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy:** Both wire halves ship in one build, so the feed **bytes** (`0x70`, `0x71`) are the only frozen contract and they do not change. Feed display names, control-message action names, and agent verb names all move freely.
- **Migration plan:**
  - Post history migrates in place on first open of a database written by an older build ([Spec S01](#s01-ledger-migration)).
  - The saved deck layout migrates on load ([P04](#p04-layout-migration)).
  - The rail width migrates on first read ([Spec S03](#s03-defaults-migration)).
  - Nothing else migrates ([P06](#p06-what-migrates)).
- **Who is impacted:** only this repository's own users; there is no external adopter of these names.
- **How to detect breakage:** an empty Overview card on a machine with history is the migration failing; a missing rail is the layout rewrite failing; a rail at default width is the defaults copy failing. All three are visible on the first launch of the rebuilt app.
- **Rollback:** revert the dash. A database already migrated forward is *not* rolled back by reverting the code — the old build would find no `gazette_posts` and start an empty channel. This is worth knowing before the landing and is the reason [Spec S02](#s02-migration-verification)'s rehearsal happens on a copy first.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### File renames {#file-renames}

Every rename below is a `git mv` so history follows the file.

| From | To |
|------|-----|
| `tugrust/crates/tugcast/src/feeds/gazette_agent.rs` | `feeds/overview_agent.rs` |
| `tugrust/crates/tugcast/src/feeds/gazette_replay.rs` | `feeds/overview_replay.rs` |
| `tugrust/crates/tugcast/src/feeds/reporter.rs` | `feeds/observer.rs` |
| `tugrust/crates/tugcast/src/feeds/reporter_wake.rs` | `feeds/observer_wake.rs` |
| `tugdeck/src/components/gazette/gazette-card.tsx` | `components/overview/overview-card.tsx` |
| `tugdeck/src/components/gazette/gazette-card.css` | `components/overview/overview-card.css` |
| `tugdeck/src/components/gazette/gazette-card-registration.tsx` | `components/overview/overview-card-registration.tsx` |
| `tugdeck/src/lib/gazette-store.ts` | `lib/overview-store.ts` |
| `tugdeck/src/lib/gazette-card-id.ts` | `lib/overview-card-id.ts` |
| `tugdeck/src/lib/gazette-measure.ts` | `lib/overview-measure.ts` |
| `tugdeck/src/lib/gazette-body-segments.ts` | `lib/overview-body-segments.ts` |
| `tugdeck/src/lib/gazette-ref-resolve.ts` | `lib/overview-ref-resolve.ts` |
| `tugdeck/src/lib/gazette-attachment-bytes.ts` | `lib/overview-attachment-bytes.ts` |
| `tugdeck/src/__tests__/gazette-store.test.ts` | `__tests__/overview-store.test.ts` |
| `tugdeck/src/lib/__tests__/gazette-body-segments.test.ts` | `lib/__tests__/overview-body-segments.test.ts` |
| `tugdeck/src/lib/__tests__/gazette-ref-resolve.test.ts` | `lib/__tests__/overview-ref-resolve.test.ts` |
| `tests/app-test/at0365-gazette-card.test.ts` | `at0365-overview-card.test.ts` |
| `tests/app-test/at0366-gazette-copy.test.ts` | `at0366-overview-copy.test.ts` |
| `tests/app-test/at0367-gazette-scrollback.test.ts` | `at0367-overview-scrollback.test.ts` |
| `tests/app-test/at0368-gazette-session-citations.test.ts` | `at0368-overview-session-citations.test.ts` |
| `tests/app-test/at0369-gazette-post-navigation.test.ts` | `at0369-overview-post-navigation.test.ts` |
| `tests/app-test/at0370-gazette-follow-bottom.test.ts` | `at0370-overview-follow-bottom.test.ts` |

The `at####` numbers are stable identities and do not change.

#### Symbols to add / modify {#symbols}

**Table T03: Rust** {#t03-rust-symbols}

| Symbol | Kind | Location | Becomes |
|--------|------|----------|---------|
| `GazetteAuthor` | enum | `tugcast-core/src/types.rs` | `OverviewAuthor` |
| `GazetteAuthor::Reporter` | variant | same | `OverviewAuthor::Observer` (serde `observer`) |
| `GazetteRefKind`, `GazetteRef`, `GazetteAttachment`, `GazettePost` | enum/struct | same | `Overview…` |
| `FeedId::GAZETTE` / `GAZETTE_INPUT` | const | `tugcast-core/src/protocol.rs` | `OVERVIEW` / `OVERVIEW_INPUT`; bytes `0x70`/`0x71` unchanged; `name()` returns `"Overview"` / `"OverviewInput"` |
| `record_gazette_post`, `list_gazette_posts_tail`, `list_gazette_posts_page`, `list_gazette_posts_for_session`, `gazette_posts_window`, `search_gazette_posts` | fn | `tugcast/src/session_ledger.rs` | `…overview_post(s)…` |
| `GazetteSearchFilter`, `GazetteSearchHit` | struct | same | `Overview…` |
| `migrate_gazette_posts_add_*` (5) | fn | same | `migrate_overview_posts_add_*` |
| *(new)* `migrate_gazette_posts_to_overview_posts` | fn | same | [Spec S01](#s01-ledger-migration) |
| `GAZETTE_DOMAIN` | const | `feeds/overview_agent.rs` | `OVERVIEW_DOMAIN = "dev.tugtool.overview"` |
| `REPORTER_POST_JOB` (`"reporter-post"`) | const | `feeds/observer.rs` | `OBSERVER_POST_JOB = "observer-post"` |
| `gazette.search` / `gazette.window` | verb strings | `feeds/operator.rs`, `feeds/overview_agent.rs` | `overview.search` / `overview.window` |
| `gazette-replay` | CLI subcommand | `tugcast/src/cli.rs` | `overview-replay` |

**Table T04: tugdeck and the host** {#t04-ts-symbols}

| Symbol | Kind | Location | Becomes |
|--------|------|----------|---------|
| `GazetteAuthor`, `GazettePostWire`, `ListGazettePostsOk` | type | `tugdeck/src/protocol.ts` | `Overview…`; author union `"observer" \| "operator" \| "user"` |
| `FeedId.GAZETTE` / `GAZETTE_INPUT` | const | same | `OVERVIEW` / `OVERVIEW_INPUT`; values unchanged |
| `list_gazette_posts` / `list_gazette_posts_ok` | control action | `protocol.ts`, `action-dispatch.ts` | `list_overview_posts` / `list_overview_posts_ok` |
| `GAZETTE_CARD_ID = "gazette"` | const | `lib/overview-card-id.ts` | `OVERVIEW_CARD_ID = "overview"` |
| `migrateComponentId` | fn | `tugdeck/src/serialization.ts` | gains a `"gazette"` → `"overview"` entry beside the existing `"dev"` → `"session"`; signature unchanged ([P04](#p04-layout-migration)) |
| `attachGazetteStore`, `getGazetteStore`, `useGazette`, `publishListGazettePostsOk`, `_resetGazetteStoreForTest`, `_ingestGazetteFrameForTest`, `_ingestGazettePageForTest` | fn | `lib/overview-store.ts` | `…Overview…` |
| `GazettePostEntry`, `GazetteSnapshot` | interface | same | `Overview…` |
| `GAZETTE_DOMAIN`, `GAZETTE_CARD_ROWS_KEY`, `DEFAULT_GAZETTE_CARD_ROWS`, `GAZETTE_MAX_ROWS` | const | same | `OVERVIEW_…` |
| `COMFORT_GAZETTE_WIDTH_PX`, `DEFAULT_GAZETTE_WIDTH_PX`, `MIN_GAZETTE_WIDTH_PX` | const | `lib/overview-measure.ts` | `…OVERVIEW_…` |
| `registerGazetteCard`, `GazetteContent`, `GazetteContentProps`, `GAZETTE_FOCUS_GROUP` | fn/component | `components/overview/*` | `…Overview…` |
| `family: "gazette"` | registration | `overview-card-registration.tsx` | `"overview"` |
| `Participant` member `"reporter"` | union member | `tugways/tug-transcript-entry.tsx` | `"observer"`, icon `Eye` |
| `TUG_ACTIONS.TOGGLE_GAZETTE` (`"toggle-gazette"`) | action | `tugways/action-vocabulary.ts` | `TOGGLE_OVERVIEW` (`"toggle-overview"`) |
| `maker.gazette` | menu item id | `command-registry.ts`, `AppDelegate.swift` | `maker.overview` |
| `showGazette` | `@objc` handler | `tugapp/Sources/AppDelegate.swift` | `showOverview`; title `"Show Overview"` |
| `publishGazettePost` | test-surface method | `tugdeck/src/test-surface.ts` | `publishOverviewPost`; `SURFACE_VERSION` → `3.0.0` ([P05](#p05-surface-major)) |
| `foldOverview`, `latestOverviewForScope`, `EMPTY_OVERVIEWS`, `overviews` | fn/const/field | `lib/pulse-store.ts` | `foldPulseOverview`, `latestPulseOverviewForScope`, `EMPTY_PULSE_OVERVIEWS`, `pulseOverviews` ([P07](#p07-pulse-collision)) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/menus.md` — the ⌃⌘G row and the `maker.gazette` row in the two tables.
- [ ] `tuglaws/focus-language.md` — three mentions of Gazette as a Class B card, including the worked example of the empty-group obligation.
- [ ] `tuglaws/entity-presentation.md` — six mentions, including the `refs` array row and the read-only-skin stamping discussion.
- [ ] `tuglaws/design-decisions.md` — four mentions across the bullseye, two-registers, and subscribed-atom decisions.
- [ ] `tuglaws/pane-model.md` — the Rail row's example list.
- [ ] `Justfile` — the `gazette-replay` recipe and its comment block.
- [ ] `CLAUDE.md` — no mention today; verify none is needed after the rename.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | The migration against a real SQLite database carrying the old schema | [Step 1](#step-1) |
| **Unit (TS)** | The layout `componentId` rewrite as a pure function over a real serialized layout | [Step 4](#step-4) |
| **Rename-following** | Existing unit and app-tests renamed and re-pointed; they prove the rename did not change behavior | [Steps 3](#step-3)–[6](#step-6) |
| **Golden / Contract** | The imposer solutions golden, regenerated by `just golden` | [Step 6](#step-6) |
| **Drift prevention** | The vestige grep, encoded as a checkpoint command | [Step 7](#step-7) |

The load-bearing test insight for this plan: **a rename's best test suite is the one that already exists.** Six app-test files and three unit-test files already drive this card, this store, and this channel end to end. If they pass unchanged in behavior after being re-pointed at the new names, the rename is proven. The only genuinely *new* tests this plan adds are for the three things that are new: the ledger migration, the layout rewrite, and the chord's move.

#### What stays out of tests {#test-non-goals}

- **No test asserts that a symbol has a particular name.** A rename is proven by the existing behavioral suite continuing to pass, plus the vestige grep. A test that pins spelling is a reflexive pin test and is banned.
- **No fake-DOM or jsdom render test** for the renamed card — `at0365`–`at0370` drive the real app and already cover it.
- **No mock-store assertion test** for the renamed store — `overview-store.test.ts` drives the real store with real frames and keeps doing so.
- **The defaults forward-copy gets no dedicated test.** It is three lines in a read path, its failure mode is a rail at default width, and testing it would cost more brittleness than the bug it could catch.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The stored channel takes its new name | done | `632f7824e` |
| #step-2 | The backend speaks Overview and Observer | done | `6e8e3bb7c` |
| #step-3 | The deck's data layer follows | done | `b64ae5204` |
| #step-4 | The card becomes the Overview card | done | `b64ae5204` |
| #step-5 | The words, the chord, and the laws | done | `bd1159d52` |
| #step-6 | The tests and goldens carry the new names | done | `56ffee139` |
| #step-7 | Integration checkpoint — no vestige survives | done | `77ab5bc7b` |

---

#### Step 1: The stored channel takes its new name {#step-1}

**Commit:** `tugcast(ledger): rename the post table and its author value`

**References:** [P01](#p01-full-migration) full migration, [Spec S01](#s01-ledger-migration), [Spec S02](#s02-migration-verification), Risk [R01](#r01-live-migration), Table [T01](#t01-persisted), (#migration-ordering, #fts-rename)

**Artifacts:**
- A new migration function on `SessionLedger` in `tugrust/crates/tugcast/src/session_ledger.rs`.
- The retargeted DDL for `overview_posts`, its index, its FTS5 index, and its three triggers.
- A Rust test covering the migration against a real old-schema database.

**Tasks:**
- [ ] Add `migrate_gazette_posts_to_overview_posts`, implementing [Spec S01](#s01-ledger-migration) exactly, and register it in the schema routine **before** the `CREATE TABLE IF NOT EXISTS` batch — see [#migration-ordering](#migration-ordering) for why the order is load-bearing.
- [ ] Rename the DDL: `gazette_posts` → `overview_posts`, `gazette_posts_session` → `overview_posts_session`, `gazette_posts_fts` → `overview_posts_fts` with `content='overview_posts'`, and the three `gazette_posts_fts_*` triggers → `overview_posts_fts_*`.
- [ ] Preserve the DDL's existing warning about `rebuild_table_if_schema_drifted`, retargeted at the new name — it is the reason the table is safe.
- [ ] Rename the five existing `migrate_gazette_posts_add_*` helpers to `migrate_overview_posts_add_*` and point their `table_columns` calls at `overview_posts`.
- [ ] Update the `main.gazette_posts_fts` entry in the schema-guard exclusion list to `main.overview_posts_fts`.
- [ ] Update the ledger's own query strings and the `author = 'reporter'` predicate in the per-session read to `'observer'`.
- [ ] Give the migration a docblock naming the condition under which it may be deleted, per [Spec S04](#s04-vestige-boundary).

**Tests:**
- [ ] A Rust test building an old-schema database with posts under all three authors, running the migration, and asserting every invariant in [Spec S02](#s02-migration-verification) — count preserved, no `'reporter'` remains, `'observer'` count equals the prior `'reporter'` count, other authors untouched, full-text search still returns its hit, and a second run is a no-op.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo build` (clean under `-D warnings`)
- [ ] Rehearse against real data per [Spec S02](#s02-migration-verification): copy the live `sessions.db` with `just db-inspect`, run the migration against the **copy**, and report the before/after post count and author breakdown in the commit summary. The live file is never opened by anything but Tug.

---

#### Step 2: The backend speaks Overview and Observer {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast: the narration channel is the Overview, its voice the Observer`

**References:** [P03](#p03-agent-verbs) agent verbs, [Spec S03](#s03-defaults-migration), Table [T03](#t03-rust-symbols), (#terminology)

**Artifacts:**
- Renamed feed modules and every Rust symbol in [Table T03](#t03-rust-symbols).
- The renamed defaults domain with its forward-copy.
- The renamed CLI subcommand and Justfile recipe.

**Tasks:**
- [ ] `git mv` the four feed modules per [#file-renames](#file-renames) and update `feeds/mod.rs`.
- [ ] Rename the `tugcast-core` types and feed-id constants per [Table T03](#t03-rust-symbols). The **bytes** `0x70`/`0x71` do not change; `name()` returns `"Overview"` / `"OverviewInput"`, and the two assertions pinning those names move with them.
- [ ] Change `OverviewAuthor::Observer`'s serde spelling to `observer` and update the `as_str` / parse arms.
- [ ] Rename the ledger's public post methods and the two search structs per [Table T03](#t03-rust-symbols), updating call sites in the feeds.
- [ ] Rename the agent verbs to `overview.search` / `overview.window` in the dispatcher, the allowlist, the error-message formatting, and **all** the instruction prose — including the closing "every verb you may ask for" list in `overview_agent.rs`, which enumerates them a second time.
- [ ] Rename `GAZETTE_DOMAIN` to `OVERVIEW_DOMAIN = "dev.tugtool.overview"` and add the forward-copy from [Spec S03](#s03-defaults-migration), with the deletion-condition docblock [Spec S04](#s04-vestige-boundary) requires.
- [ ] Rename the model job `reporter-post` → `observer-post` at its constant, its registration, and the tests naming it.
- [ ] Rename the CLI subcommand `gazette-replay` → `overview-replay` and the `Justfile` recipe and comment block that drive it.
- [ ] Update `tugcast/src/main.rs`, which holds 46 mentions and no rename of its own: the `overview_replay` dispatch, the `gazette_model` / `gazette_max_workers` / `gazette_agent` locals and the domain-key reads behind them, and the `ReporterBridge` / `ReporterBridgeConfig` construction.
- [ ] Rewrite the module docblocks and comments across the four feeds and `protocol.rs` so the prose describes an Overview channel and an Observer voice.
- [ ] Sweep the remaining Rust mentions enumerated in [Table T05](#t05-incidental) — including `base_motion.rs`, whose docblock cites `reporter_wake.rs` by filename. After this step no file under `tugrust/` mentions either retired name.

**Tests:**
- [ ] Existing tests in `operator.rs`, `overview_agent.rs`, `agent_supervisor.rs`, and `session_ledger.rs` follow the renames and keep passing — this is the behavioral proof that the rename changed nothing.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugrust && cargo build` (clean under `-D warnings`)
- [ ] `just --list` still resolves, and `overview-replay` appears where `gazette-replay` was.

---

#### Step 3: The deck's data layer follows {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck: the Overview protocol and store`

**References:** [P05](#p05-surface-major) surface major, [P07](#p07-pulse-collision) pulse collision, Table [T04](#t04-ts-symbols), (#file-renames)

**Artifacts:**
- Renamed protocol types, control actions, and store.
- The five renamed `lib/` leaf modules.
- `SURFACE_VERSION` at `3.0.0`.
- Qualified pulse-store internals.

**Tasks:**
- [ ] Rename the protocol types and feed-id constants in `tugdeck/src/protocol.ts` per [Table T04](#t04-ts-symbols); the author union member becomes `"observer"`, and the `GAZETTE_AUTHORS` runtime guard array follows.
- [ ] Rename the control actions `list_gazette_posts` / `list_gazette_posts_ok` to `list_overview_posts` / `list_overview_posts_ok` in `protocol.ts` and in the `action-dispatch.ts` registration, including the `console.warn` text.
- [ ] `git mv` the five `lib/gazette-*.ts` leaf modules and rename their exported symbols per [Table T04](#t04-ts-symbols).
- [ ] Rename the scroll-region key `gazette-transcript` → `overview-transcript`; per [P06](#p06-what-migrates) no migration is written for it.
- [ ] Rename `publishGazettePost` → `publishOverviewPost` in `test-surface.ts`, bump `SURFACE_VERSION` to `3.0.0`, and add the `3.0.0` docblock entry in the format the existing entries use, explaining the rename and the removal rule that makes it a major.
- [ ] Qualify the bare pulse internals per [P07](#p07-pulse-collision): `foldOverview`, `latestOverviewForScope`, `EMPTY_OVERVIEWS`, and the `overviews` snapshot field, in `lib/pulse-store.ts` and its readers.
- [ ] Sweep the remaining tugdeck data-layer mentions enumerated in [Table T05](#t05-incidental) — mostly imports and docblock prose in the stores and the annotator.

**Tests:**
- [ ] `__tests__/overview-store.test.ts`, `lib/__tests__/overview-body-segments.test.ts`, and `lib/__tests__/overview-ref-resolve.test.ts` — renamed, re-pointed, and passing unchanged in what they assert.
- [ ] `__tests__/protocol.test.ts` follows the type and action renames.
- [ ] `lib/__tests__/pulse-store.test.ts` follows the qualification.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test`

---

#### Step 4: The card becomes the Overview card {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck: the Overview card, and the layout that finds it`

**References:** [P04](#p04-layout-migration) layout migration, [Spec S04](#s04-vestige-boundary), Table [T04](#t04-ts-symbols), (#state-zone-mapping, #persistence-surfaces)

**Artifacts:**
- The renamed `components/overview/` tree.
- `OVERVIEW_CARD_ID = "overview"` and the card registration under it.
- One new entry in `serialization.ts`'s `migrateComponentId` rename map, with a unit test.

**Tasks:**
- [ ] `git mv` the `components/gazette/` tree to `components/overview/` and rename the three files per [#file-renames](#file-renames).
- [ ] Rename the component symbols and the focus-group constant per [Table T04](#t04-ts-symbols), and change `family` from `"gazette"` to `"overview"`.
- [ ] Change `OVERVIEW_CARD_ID` to `"overview"` and update every importer, including `main.tsx`, `deck-canvas.tsx`, `action-dispatch.ts`, and the Lens's card section.
- [ ] Add the `"gazette"` → `"overview"` entry to the **existing** `migrateComponentId` in `tugdeck/src/serialization.ts`, beside the `"dev"` → `"session"` entry it already carries, and extend its docblock to name the second rename. Do **not** write a new rewrite in `deck-manager.ts` — `migrateComponentId` already runs inside `deserialize`, which is upstream of `filterDeckStateByRegistration`, so the ordering constraint is satisfied by construction ([P04](#p04-layout-migration)).
- [ ] Update the registration docblock's INVARIANT paragraph, which explains that a card unregistered at load evaporates its rail; it should now also point at the rename map as the reason a pre-rename layout still resolves.
- [ ] Rename the CSS class and selector prefixes in `overview-card.css` and the card's own markup, including the `data-testid` and `data-tug-scroll-key` values.
- [ ] Rewrite the card's and the registration's module docblocks so the prose describes the Overview.
- [ ] Sweep the remaining card-host mentions enumerated in [Table T05](#t05-incidental).

**Tests:**
- [ ] A unit test over `migrateComponentId`: assert that `"gazette"` maps to `"overview"`, that the existing `"dev"` → `"session"` entry still holds, and that an unrelated id passes through unchanged.
- [ ] A test that a **real** serialized layout containing a card with `componentId: "gazette"` survives `deserialize` followed by `filterDeckStateByRegistration` against the real card registry — the pane, its stack, and the card are all still present. `__tests__/changeset-card-retired.test.ts` is the precedent for driving that pair against the real registry, and this is the assertion that actually proves the rail does not evaporate; the map test alone would pass even if the map were never called.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build` — the debug app loads the production rollup bundle, so this is what proves the card actually builds.

---

#### Step 5: The words, the chord, and the laws {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck: Show Overview on ⌃⌘O, and the Observer's eye`

**References:** [P02](#p02-chord-moves) chord moves, Table [T02](#t02-terms), Table [T04](#t04-ts-symbols), (#documentation-plan)

**Artifacts:**
- The renamed action, chord, menu item, and Swift handler.
- The Observer label and its `Eye` glyph.
- The five updated `tuglaws/*.md` files.

**Tasks:**
- [ ] Rename `TUG_ACTIONS.TOGGLE_GAZETTE` → `TOGGLE_OVERVIEW` and its wire string `"toggle-gazette"` → `"toggle-overview"`, in `action-vocabulary.ts`, `command-registry.ts`, `deck-canvas.tsx`, `action-dispatch.ts`, and `sidebar-toggle.ts`.
- [ ] Move the chord from `KeyG` to `KeyO` with label `"o"`, retitle the command `"Show Overview"`, and rewrite the registry comment so it names the ⌃⌘L / ⌃⌘J / ⌃⌘O grammar.
- [ ] Rename the menu item id `maker.gazette` → `maker.overview` in both `command-registry.ts` and `AppDelegate.swift`, and rename the Swift handler `showGazette` → `showOverview` with the title `"Show Overview"`.
- [ ] Change the author label map's `reporter: "Reporter"` to `observer: "Observer"`, and the participant map to `observer: "observer"`.
- [ ] Change the `Participant` union member and give it the lucide `Eye` glyph in the icon map, replacing `Newspaper`. The **card's** icon stays `Newspaper` per [Table T02](#t02-terms).
- [ ] Rename the participant CSS custom property and attribute selector in `tug-transcript-entry.css` from `reporter` to `observer`.
- [ ] Update the `/private` slash-command description to say Overview.
- [ ] Update the five `tuglaws/*.md` files per [#documentation-plan](#documentation-plan) — including both tables in `menus.md`, which carry the chord and the menu item id.
- [ ] Sweep the remaining chrome and prose mentions enumerated in [Table T05](#t05-incidental). After this step the only files outside `tests/` still naming either retired word are the ones [Spec S04](#s04-vestige-boundary) sanctions.

**Tests:**
- [ ] `components/tugways/__tests__/command-routing-drift.test.ts` and `kbf-derivation.test.ts` follow the action rename and keep passing — the drift test is what would catch a half-renamed action.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just build-app` — the Swift change is only real once the app is rebuilt.

---

#### Step 6: The tests and goldens carry the new names {#step-6}

**Depends on:** #step-5

**Commit:** `test: the Overview suite follows its subject`

**References:** [P02](#p02-chord-moves) chord moves, [P05](#p05-surface-major) surface major, (#file-renames, #test-plan-concepts)

**Artifacts:**
- Six renamed app-test files with updated `@covers` lines.
- The regenerated imposer golden.
- Updated references in the five app-tests that mention the channel without being about it.

**Tasks:**
- [ ] `git mv` the six `at03xx-gazette-*.test.ts` files per [#file-renames](#file-renames), keeping their `at####` numbers.
- [ ] Update every `@covers` line in those files to the renamed source paths — `overview-card.tsx`, `overview-card.css`, `overview-card-registration.tsx`, `overview-store.ts`, `overview-attachment-bytes.ts`, `overview-ref-resolve.ts`, `overview-body-segments.ts`.
- [ ] Rewrite each file's docblock prose to describe the Overview and the Observer.
- [ ] Retarget `at0365`'s chord claim to ⌃⌘O, and add an assertion that ⌃⌘G no longer toggles the rail — the negative half is what proves the move rather than a duplication.
- [ ] Update `at0365`'s author-glyph assertion to expect the `Eye` glyph and the label `Observer`.
- [ ] Update the `publishGazettePost` call sites to `publishOverviewPost`.
- [ ] Update the incidental references in `at0168-menu-structure`, `at0303-imposer-space-allocator`, `at0387-session-identity-menu`, `at0422-filter-forward`, and `zz-probe-layout-miniature` — these name the card or the menu item without being about it.
- [ ] Regenerate the imposer golden with `just golden`; never hand-edit `imposer-solutions.json`.
- [ ] Update `layout-imposer.test.ts`, `layout-imposer-solutions.test.ts`, `layout-tree.test.ts`, and `session-identity.test.ts` where they name the card id.

**Tests:**
- [ ] The six renamed app-test files pass from the main checkout after the landing — see the constraint in [#constraints](#constraints) about the corpus refusing a worktree.
- [ ] `just app-test-covers-check` resolves every `@covers` path.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test-covers-check`
- [ ] `git diff --stat` on `imposer-solutions.json` shows only the card-id substitution, confirming the golden's regeneration changed the name and nothing else.

---

#### Step 7: Integration checkpoint — no vestige survives {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [Spec S04](#s04-vestige-boundary), (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Run the vestige grep and confirm every surviving hit falls inside the boundary [Spec S04](#s04-vestige-boundary) draws. The expected survivors outside `dash/` and `capabilities/` are exactly three files: the ledger migration in `session_ledger.rs`, the defaults forward-copy in `feeds/overview_agent.rs`, and the rename-map entry in `tugdeck/src/serialization.ts` — plus the unrelated Vite build-reporter comment in `tugdeck/vite.config.ts`. **A hit anywhere else is a straggler and belongs to whichever earlier step owns its layer** ([Table T05](#t05-incidental)); fix it there and re-run that step's checkpoint rather than patching it here, since this step carries no commit.
- [ ] Confirm the two deletable migrations carry their deletion-condition docblock, and that the `migrateComponentId` entry does **not** — it is permanent by [P04](#p04-layout-migration), and a deletion note on it would be wrong.
- [ ] Launch the built app against a **copy** of a real instance directory and confirm the channel's history is present, the rail is where it was, and its width survived.

**Tests:**
- [ ] The seven-file app-test selection covering the renamed surfaces plus the menu and layout tests that reference them.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` and `cargo build`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test at0365-overview-card.test.ts at0366-overview-copy.test.ts at0367-overview-scrollback.test.ts at0368-overview-session-citations.test.ts at0369-overview-post-navigation.test.ts at0370-overview-follow-bottom.test.ts at0168-menu-structure.test.ts` — run bare; the recipe prints the finished report, and piping it into a filter turns a green run into a silent failure.
- [ ] `grep -ril "gazette\|reporter" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=dist --exclude-dir=roadmap --exclude-dir=capabilities .` returns exactly four paths: `tugrust/crates/tugcast/src/session_ledger.rs`, `tugrust/crates/tugcast/src/feeds/overview_agent.rs`, `tugdeck/src/serialization.ts`, and `tugdeck/vite.config.ts`. Any fifth path is a straggler.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The narration channel is the **Overview** and its summarizing voice the **Observer**, in every line of code, every stored row, every wire name, every UI word, and every law — with the retired spellings surviving only in historical roadmap documents and three migrations that exist to carry the old world forward.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The vestige grep in [Step 7](#step-7) returns exactly the four sanctioned paths and no fifth.
- [ ] Every post in a pre-existing instance is readable in the Overview card, and channel search still returns hits (rehearsed on a copy per [Spec S02](#s02-migration-verification), confirmed live at [Step 7](#step-7)).
- [ ] No row anywhere reads `author = 'reporter'`.
- [ ] The rail survives the rename with its pane, side, and width.
- [ ] ⌃⌘O toggles the Overview; ⌃⌘G does nothing.
- [ ] An Observer post shows the `Eye` glyph and the label `Observer`; the card still wears `Newspaper`.
- [ ] `cargo nextest run`, `cargo build`, `bun test`, `bunx tsc --noEmit`, `bunx vite build`, and `just app-test-covers-check` are clean.

**Acceptance tests:**
- [ ] The six renamed app-test files, green from the main checkout.
- [ ] The migration test from [Step 1](#step-1).
- [ ] The layout-rewrite test from [Step 4](#step-4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Close the Join sheet report.** This plan's landing is the deliberate exercise [`dash-closure-brief.md`](dash-closure-brief.md#join-hunt) prescribes. Whether it becomes a downgrade written into [`closing-dash-backend-issues-brief.md`](closing-dash-backend-issues-brief.md#join-sheet) or a capture depends on what the owner sees while landing it — which is theirs to observe, not this plan's to assume.
- [ ] Delete the two deletable migrations once no installation predates the rename. The `migrateComponentId` entry stays permanently ([P04](#p04-layout-migration)).
- [ ] Reconsider whether the per-session pulse overview wants a distinct word ([P07](#p07-pulse-collision) parked it deliberately).

| Checkpoint | Verification |
|------------|--------------|
| Storage renamed without loss | [Step 1](#step-1) migration test + the real-data rehearsal in [Spec S02](#s02-migration-verification) |
| Backend speaks the new names | `cargo nextest run` at [Step 2](#step-2) |
| Deck data layer renamed | `bun test` + `tsc --noEmit` at [Step 3](#step-3) |
| The card survives a saved layout | Layout-rewrite unit test at [Step 4](#step-4) |
| The chord moved | `at0365` at [Step 6](#step-6) |
| No vestige survives | The grep at [Step 7](#step-7) |
