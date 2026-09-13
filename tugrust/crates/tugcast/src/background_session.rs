//! The card id a session with no card carries.
//!
//! A Session card's `card_id` addresses a card in a deck. A session spawned by
//! something that is not a deck — a tripwire's work tier, and whatever
//! background spawner comes after it — still needs an owner in that field, so
//! it carries `tripwire:<owner>` instead: a string that names who asked rather
//! than addressing anything. This module is where that convention is minted
//! and where it is recognised, so the next background spawner inherits the one
//! answer to "does this `card_id` name a deck card?" rather than inventing a
//! second prefix ([B04]).
//!
//! The recognising half is the point. Written in two places and read in none,
//! the prefix was a convention with no guard: nothing downstream could tell a
//! live session held by another card from one held by nobody a user could be
//! sent to, which is the distinction adoption turns on.

/// The card-id prefix a session with no card carries.
pub(crate) const TRIPWIRE_CARD_PREFIX: &str = "tripwire:";

/// Mint the card id for a background owner's session.
pub(crate) fn background_card_id(owner: &str) -> String {
    format!("{TRIPWIRE_CARD_PREFIX}{owner}")
}

/// Whether a `card_id` names a background owner rather than a deck card.
///
/// `None` — a session no card has ever been bound to — is not background: it
/// is unbound, which is a different fact and a different remedy.
pub(crate) fn is_background_card_id(card_id: Option<&str>) -> bool {
    card_id.is_some_and(|id| id.starts_with(TRIPWIRE_CARD_PREFIX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_id_is_recognised() {
        let id = background_card_id("nightly-audit");
        assert_eq!(id, "tripwire:nightly-audit");
        assert!(is_background_card_id(Some(&id)));
    }

    #[test]
    fn unbound_and_deck_cards_are_not_background() {
        // Unbound is its own fact: no card has ever held this session.
        assert!(!is_background_card_id(None));
        assert!(!is_background_card_id(Some("card-7")));

        // The prefix has to open the id. A deck card whose own id happens to
        // carry the word later on names a card, and sending a user to it is
        // exactly right.
        assert!(!is_background_card_id(Some("card-tripwire:nightly-audit")));
    }
}
