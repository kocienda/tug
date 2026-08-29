//! The deck-reported seating board — which tug sessions are seated on open
//! Session cards, right now, according to the decks connected to this
//! process.
//!
//! `sessions.state` answers "is a subprocess running", which is the wrong
//! question for the changeset's orphan lift ([D120]): between the startup
//! demote and a card's next spawn, every session on the machine reads
//! `closed` while the user's cards sit open on their work — and the lift,
//! reading `closed` as *abandoned*, offers the user their own files back.
//! Seatedness is the missing fact, and only the deck holds it, so the deck
//! reports it: a `deck_seatings` CONTROL frame carries the full replacement
//! set for that client, and the supervisor writes it here.
//!
//! Ephemeral by design, mirroring the fact it describes: the board is keyed
//! by WebSocket client id, a disconnect drops its entry, and a reconnect is
//! a fresh id that starts empty — a stale report cannot outlive the deck
//! that made it. Nothing is persisted; a tugcast restart starts from
//! "seated on nothing", which is the truth until a deck reconnects and
//! says otherwise.
//!
//! Published as a process-global on the [`ConflictBoard`] precedent
//! (`base_motion.rs`): the changeset composition reads it through a free
//! function rather than a parameter threaded through `compose_snapshot`
//! and its every caller.
//!
//! [`ConflictBoard`]: super::base_motion

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct SeatingBoard {
    by_client: Mutex<HashMap<u64, HashSet<String>>>,
}

static BOARD: OnceLock<SeatingBoard> = OnceLock::new();

fn board() -> &'static SeatingBoard {
    BOARD.get_or_init(SeatingBoard::default)
}

/// Replace one deck client's reported seatings wholesale (the frame is a
/// full replacement, so a missed delta can never wedge the set). Returns
/// whether the report changed anything — the caller bumps the aggregate
/// recompute on `true`.
pub fn set_deck_seatings(client_id: u64, session_ids: HashSet<String>) -> bool {
    let mut by_client = board().by_client.lock().expect("seating board mutex");
    if session_ids.is_empty() {
        by_client.remove(&client_id).is_some()
    } else if by_client.get(&client_id) == Some(&session_ids) {
        false
    } else {
        by_client.insert(client_id, session_ids);
        true
    }
}

/// Drop a departed client's seatings. Returns whether anything was held —
/// the caller bumps the aggregate recompute on `true` so a closed deck's
/// cards stop counting as seated.
pub fn drop_deck_seatings(client_id: u64) -> bool {
    let mut by_client = board().by_client.lock().expect("seating board mutex");
    by_client.remove(&client_id).is_some()
}

/// The union of every connected deck's seated session ids — the "an open
/// card holds this session" fact the changeset compose folds into liveness.
/// Empty when no deck is connected, which is the truth in that case.
pub fn seated_session_ids() -> HashSet<String> {
    let by_client = board().by_client.lock().expect("seating board mutex");
    by_client.values().flatten().cloned().collect()
}
