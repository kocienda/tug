<!-- brief-skeleton v1 -->

# One owner in `tugcore` for the shared-ledger DDL, its version, and the migration loop

**Purpose:** The `changes.db` schema is created in two production places, one of them with no version gate; three ledgers each hand-roll the same `user_version` migration loop; and the DDL for the tables other crates read is pasted into their tests nine times. A column added in one place is a column the others never hear about.

---

## Purpose {#purpose}

Item 21 of `briefs/audit-punch-list.md`:

> 21. One owner for shared-ledger DDL and version in `tugcore`. `draft.rs` currently creates a table with no migration regime, and test DDL is pasted five times.

No schema changes. `CHANGES_SCHEMA_VERSION` stays at 4 and every migration applies the same SQL in the same order; what moves is where the SQL is written.

---

## Evidence {#evidence}

**[F01] `changes.db` has two production DDL owners** — `tugcast/src/session_ledger.rs` holds `CHANGES_SCHEMA_VERSION = 4` (:244), `CHANGES_MIGRATIONS` (:258, three entries), the `file_events` DDL (:2611), `changeset_drafts` (:2638), `file_event_spans` (:293), and `bootstrap_changes_schema` (:2528) with the sidecar stamp helpers (:310-339). `tugtool/src/draft.rs:428-439` runs its own `CREATE TABLE IF NOT EXISTS changeset_drafts` with the same columns, with no `user_version` read or stamp, reached under `TUG_CHANGES_DB` isolation (:339). Nothing outside `session_ledger.rs` references `CHANGES_SCHEMA_VERSION`. **(verified)**

**[F02] Three hand-rolled migration loops** — `tugcore/src/session_index.rs:155-170` (`SESSION_INDEX_SCHEMA_VERSION = 1`, empty list), `tugcast/src/prompt_ledger.rs:185-201` (`PROMPT_HISTORY_SCHEMA_VERSION = 2`, one entry), and the changes bootstrap in [F01]. All three are `&[(i64, &str)]` applied above the current `PRAGMA user_version` and then stamped. `tugcore/src/ledger_db.rs` exports `open`, `apply_pragmas`, `attach`, `attach_read_only`, the writer lock, and the `no_ad_hoc_ledger_opens` test (:333), and has no migration helper. **(verified)**

**[F03] Other crates read the session-side schema and recreate it in tests** — production reads outside tugcast: `tugarc-core/src/ops/commit.rs:232-234` (`sessions` joined to `lines`), `ops/show.rs:903` and :939 (`sessions`), `ops/join.rs:501` (`changeset_drafts`). Test DDL for `sessions`, `file_events`, and `file_event_spans` is pasted five times in `tugchanges-core/src/changes.rs` (:711, :959, :996, :1119, :1310) and four times in `tugchanges-core/src/ledger.rs`; `tugarc-core` has it in `ops/commit.rs`, `ops/join.rs` (twice), `ops/show.rs`, and `ops/test_support.rs:499`; `tugtool/tests/changes_cli.rs` has six sites; `tugcore/src/session_finder.rs:603-608` four. **(verified)**

**[F04] The fixture feature carries no schema** — `tugcore`'s `test-fixtures` feature gates only `hostile_repo`, and is already a dev-dependency of tugcast, tugarc-core, and tugchanges-core. **(verified)**

**[F05] `tugtool` cannot link tugcast** — which is why `session_index.rs` already lives in `tugcore` (`CLAUDE.md`, "Ledger databases"); the same constraint decides where the shared DDL goes. **(verified by the existing layout)**

---

## Decisions {#decisions}

**[B01] `tugcore::changes_schema` owns `CHANGES_SCHEMA_VERSION`, the three DDL strings, `CHANGES_MIGRATIONS`, and `bootstrap(conn)`.** tugcast's `bootstrap_changes_schema` calls it and keeps the sidecar stamp, which is tugcast's refusal protocol and not schema; `draft.rs` calls `bootstrap` instead of its own `CREATE TABLE`, so the isolated path gets the version gate it lacks today. [F05] fixes the home; `session_index` is the precedent.

**[B02] `tugcore::ledger_db::migrate(conn, target_version, migrations)` replaces the three loops.** Same semantics, written once: read `user_version`, apply entries above it in order inside one transaction, stamp. The three owners keep their version constants and lists and lose their loops. A fourth ledger gets the loop for free, and `no_ad_hoc_ledger_opens` gets a sibling test that every `PRAGMA user_version` write in the workspace is inside this function.

**[B03] The three session-side tables other crates read (`sessions`, `lines`, `minted_tags`) move their DDL strings to `tugcore::session_schema`, and tugcast's `SessionLedger` creates them from those strings.** [F03] shows the columns are already a cross-crate contract; a string in `tugcore` makes it one on purpose. The other ten `sessions.db` tables are read by tugcast alone and stay where they are.

**[B04] `tugcore::test_fixtures::ledgers()` (behind `test-fixtures`) builds a temp `changes.db` through the real `bootstrap` and a temp `sessions.db` from the [B03] strings, and the nine pasted DDL blocks become calls to it.** A fixture that runs the production bootstrap cannot drift from it. The gauge is `CREATE TABLE` in test code across tugarc-core, tugchanges-core, tugtool, and tugcore's `session_finder` reaching zero for those tables; tugcast's own tests of its own tables are not in the count.

**[B05] Order: [B02] first (pure mechanism, three callers), then [B01], then [B03], then [B04].** The helper is the smallest change and proves the loop is one loop; the changes schema move is the one that fixes a real gap (the ungated `draft.rs` path); the session strings and the fixture come after because the fixture reads both.

---

## Open Questions {#open-questions}

- None. The one judgment call, which `sessions.db` tables cross the crate line, is answered by [F03]: the ones other crates already read.

---

## Non-goals {#non-goals}

- **Any schema or version change.** Version stays 4; a migration that does nothing new is not written.
- **A migration framework crate.** Three lists of string pairs do not need one.
- **Moving `SessionLedger`'s other ten tables.** [B03].
- **Touching the sidecar refusal protocol.** It is tugcast's, and the ledger-locks arc just worked on it.

---

## Exit {#exit}

An arc. Steps as ordered in [B05], each ending with `cargo nextest run` across the workspace green, since every crate in [F03] compiles against the moved strings. The `draft.rs` step lands with a test that opens an isolated `changes.db` through `tugtool` and asserts `user_version` is stamped. Run it one after the other with `async-ledger-handle`, never concurrently; both edit `session_ledger.rs`.
