//! The `sessions.db` tables other crates read, in one place.
//!
//! `sessions.db` is tugcast's per-instance ledger, and tugcast's
//! `SessionLedger` creates every one of its tables. Three of them are a
//! contract beyond tugcast: tugarc-core joins `sessions` to `lines` to name
//! the session behind a commit and reads `sessions` for an arc's seat,
//! tugtool's `restore-names` writes a stranded line's segment back, and
//! `session_finder` resolves a callsign through all three — `minted_tags`
//! being the arbiter a retired callsign still resolves through. Their
//! DDL lives here so that contract is written once, on purpose; tugcast runs
//! these strings, and the ledger fixture builds its `sessions.db` from them.
//!
//! The rest of `sessions.db` is tugcast's alone and stays there. These tables
//! are not versioned — `sessions.db` upgrades itself by idempotent column
//! adds in tugcast — so a column added here is added there too, by the same
//! self-healing migration that would have added it before.

/// A **line of work** and its identity, with its indexes.
pub const CREATE_LINES_SQL: &str = "
    -- A **line of work** and its identity ([P01]). The callsign and
    -- the user's name live here, once, for however many session ids
    -- the line lives through — so an id change has nothing to copy.
    CREATE TABLE IF NOT EXISTS lines (
        line_id       TEXT PRIMARY KEY,
        tag           TEXT NOT NULL UNIQUE,
        name          TEXT,
        name_user_set INTEGER NOT NULL DEFAULT 0,
        -- The card the line is seated on. NULL for a line the
        -- external scan discovered and nothing has resumed ([P07]).
        card_id       TEXT,
        project_dir   TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER NOT NULL
    );

    -- A user-set name is unique across lines, enforced at the write
    -- ([P11]): a rename onto a taken name TAKES it, clearing the
    -- previous holder's name in the same transaction, so the newest
    -- gesture wins and the index still holds. Auto titles are exempt —
    -- two lines may perfectly well be auto-titled the same thing.
    CREATE UNIQUE INDEX IF NOT EXISTS lines_user_name
        ON lines(name) WHERE name_user_set = 1;

    CREATE INDEX IF NOT EXISTS lines_card ON lines(card_id);
";

/// One session segment of a line, with its indexes. References `lines`, so
/// [`CREATE_LINES_SQL`] runs first.
pub const CREATE_SESSIONS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS sessions (
        session_id        TEXT PRIMARY KEY,
        workspace_key     TEXT NOT NULL,
        project_dir       TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        last_used_at      INTEGER NOT NULL,
        turn_count        INTEGER NOT NULL DEFAULT 0,
        last_user_prompt  TEXT,
        state             TEXT NOT NULL,
        card_id           TEXT,
        -- The line this row is a segment of ([P01]). Identity is the
        -- line's; nothing here holds a callsign or a name.
        line_id           TEXT NOT NULL REFERENCES lines(line_id),
        -- Fork provenance ([P11]): which session this one was
        -- rewind-forked from, and the prompt uuid of the rewind
        -- point. Both NULL for a root session. Provenance lives in
        -- these columns, never in the callsign's spelling — the
        -- callsign is the line's and does not move.
        forked_from_session_id TEXT,
        fork_point        TEXT,
        -- Stage provenance ([P10]): what a rotation seated this
        -- session as. Both NULL on a session no rotation seated. They
        -- live here rather than being reconstructed from an arc's run
        -- record, because a rotation need not have an arc behind it —
        -- and its transcript is an invariant either way.
        stage_label       TEXT,
        stage_model       TEXT,
        -- The rolling generated description ([P07]). NULL until the
        -- Summarize lane writes one; frozen (never written) once the
        -- user has renamed the session.
        synopsis          TEXT,
        -- The Overview privacy flag. `1` means this session is out of
        -- the fact base and out of the channel: no facts recorded, no
        -- Observer post, and every Operator verb that reads sessions
        -- skips it. From-now-on semantics — marking a session private
        -- hides it going forward and scrubs nothing already written.
        private           INTEGER NOT NULL DEFAULT 0,
        -- The arc this session is working on ([P01]/[P08]):
        -- `arc_id` is the owner key and the authority, `arc_name`
        -- is denormalized for display. NULL when unbound, and
        -- cleared when the session closes — bound-ness is defined
        -- over live sessions ([L27]).
        arc_id           TEXT,
        arc_name         TEXT,
        -- Which kind of `closed` this row is. `1` marks the startup
        -- demote — the *process* under the session ended, not the
        -- session — and is the one state `revive_on_activity` may
        -- correct on live-borne evidence. A deliberate close
        -- (`mark_closed`) and a spawn both clear it: closed-by-hand
        -- stays closed, and a spawned row is live on its own terms.
        demoted           INTEGER NOT NULL DEFAULT 0,
        -- The card owes a hand-back: a rotation the user did not ask
        -- for put it on a named model, and nothing but the restore
        -- will take it off. `1` while owed, cleared when the restore
        -- goes out.
        --
        -- On disk rather than in the wheel's memory alone, because
        -- the debt outlives the process that took it on: a tugcast
        -- restart between the rotation and the next turn's end used
        -- to drop the arming, and tugcode reuses its manager's
        -- selector for every later spawn — so the card stayed pinned
        -- on a stage model through the user's own `/new`, forever.
        hand_back_owed    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS sessions_workspace_recent
        ON sessions(workspace_key, last_used_at DESC);

    -- The fork edge, read child-ward: given a session id, which
    -- session (if any) was forked from it. `lineage_chain` walks it
    -- once per hop to replay a card's transcript parent-ward.
    CREATE INDEX IF NOT EXISTS sessions_forked_from
        ON sessions(forked_from_session_id);
";

/// The all-time callsign arbiter.
pub const CREATE_MINTED_TAGS_SQL: &str = "
    -- The all-time tag arbiter (Spec S08). `sessions` rows are hard
    -- DELETEd — trash, the cascade paths, the age sweep — so the
    -- `sessions_tag` index above can enforce uniqueness among live
    -- sessions but not permanence. Commit trailers cite tags, and a
    -- recycled tag makes an old commit's citation resolve to a
    -- different session, so permanence rests here instead.
    --
    -- ROWS ARE NEVER DELETED FROM THIS TABLE. Not on trash, not on
    -- cascade delete, not on eviction. A tag outlives its session by
    -- design; deleting rows here silently restores recycling.
    --
    -- The guarantee is per-ledger: `sessions.db` is per-instance, so
    -- it holds against every tag *this* ledger minted. A trailer read
    -- against another machine's ledger simply misses (the citation
    -- renders unresolvable), which is safe; a wiped ledger re-opens
    -- recycling on that machine.
    CREATE TABLE IF NOT EXISTS minted_tags (
        tag        TEXT PRIMARY KEY,
        -- The line that owns this spelling — the whole of what a
        -- retired spelling resolves to ([P08]). NULL only transiently,
        -- inside `migrate_sessions_to_lines`, which asserts otherwise
        -- before it commits.
        line_id    TEXT,
        -- The segment that spent the spelling. Kept as history: which
        -- id was live at the moment the line took this name.
        session_id TEXT NOT NULL,
        minted_at  INTEGER NOT NULL
    );
";

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn the_three_tables_create_in_order_and_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        for _ in 0..2 {
            conn.execute_batch(CREATE_LINES_SQL).unwrap();
            conn.execute_batch(CREATE_SESSIONS_SQL).unwrap();
            conn.execute_batch(CREATE_MINTED_TAGS_SQL).unwrap();
        }
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
                 AND name IN ('lines', 'sessions', 'minted_tags')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 3);
    }
}
