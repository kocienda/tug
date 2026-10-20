//! The deck bus: addressed envelopes between pages.
//!
//! `DECK_BUS` (0xD0) carries one JSON envelope per frame. A page sends a
//! [`BusOutbound`] — a target, a kind, and whatever else the envelope
//! carries — and tugcast delivers a [`BusDelivered`], which adds the sender
//! as tugcast registered it, so a page cannot speak as another.
//!
//! tugcast reads addressing and nothing else. It parses `to` and a closed
//! `kind` set and passes every other top-level field through verbatim: a
//! store's key and version, an action's id, a request's correlation, and the
//! opaque `payload`. What those mean is the receiving page's business — each
//! is declared once, in TypeScript, beside the codec that validates it
//! (`tugdeck/src/bus/declarations/`), so a malformed payload is refused where
//! it can be seen rather than stripped in transit. Direction is the
//! declaration's too; the router enforces none.
//!
//! These types are the Rust half of `tugproto/src/bus.ts`, and both halves
//! are held to `tugproto/src/__tests__/fixtures/bus-parity.json`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A page role a bus envelope can be addressed to. A tool is never one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BusRole {
    /// The newest live shell page.
    Shell,
    /// Every live body page.
    Body,
}

/// Whom a bus envelope is for: `"shell"`, `"body"`, `{"card": "<id>"}` or
/// `{"page": "<page_id>"}`.
///
/// Serde's untagged form reads a unit variant only from `null`, so the two
/// role strings go through [`BusRole`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BusTarget {
    Role(BusRole),
    Card { card: String },
    Page { page: String },
}

/// What an envelope is. tugcast routes every kind the same way; a kind not
/// named here fails to parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BusKind {
    /// A page announcing itself, or answering another's announcement.
    Hello,
    /// A shared store's snapshot.
    State,
    /// A routed action, or a proposal to a store's owner.
    Action,
    /// A request that wants a reply.
    Request,
    /// The reply to a request.
    Reply,
}

/// The sender of a delivered envelope, stamped by tugcast from the identity
/// the sender's hello registered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusFrom {
    pub page_id: String,
    pub role: BusRole,
    pub card_id: Option<String>,
}

/// An envelope as a page sends it: addressing, and the rest carried as is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BusOutbound {
    pub to: BusTarget,
    pub kind: BusKind,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// An envelope as tugcast delivers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BusDelivered {
    pub from: BusFrom,
    pub to: BusTarget,
    pub kind: BusKind,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl BusOutbound {
    /// The envelope as delivered from `from`. A `from` the page wrote is
    /// dropped, so the stamp is the only sender a receiver sees.
    pub fn deliver(mut self, from: BusFrom) -> BusDelivered {
        self.rest.remove("from");
        BusDelivered {
            from,
            to: self.to,
            kind: self.kind,
            rest: self.rest,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tugproto/src/__tests__/fixtures/bus-parity.json"
        );
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        serde_json::from_str(&text).expect("bus-parity.json is JSON")
    }

    fn delivered() -> Vec<BusDelivered> {
        serde_json::from_value(fixture()["delivered"].clone()).expect("the fixture parses")
    }

    #[test]
    fn every_fixture_envelope_round_trips_as_delivered() {
        let fixture = fixture();
        let envelopes = fixture["delivered"]
            .as_array()
            .expect("the fixture's `delivered` is an array");
        assert!(!envelopes.is_empty(), "the fixture carries envelopes");
        for envelope in envelopes {
            let parsed: BusDelivered = serde_json::from_value(envelope.clone())
                .unwrap_or_else(|e| panic!("{envelope} does not parse: {e}"));
            let written = serde_json::to_value(&parsed).expect("serializes");
            assert_eq!(
                &written, envelope,
                "{envelope} does not survive a round trip"
            );
        }
    }

    #[test]
    fn the_fixture_names_every_kind() {
        let envelopes = delivered();
        let has = |pred: &dyn Fn(&BusDelivered) -> bool| envelopes.iter().any(pred);
        for kind in [
            BusKind::Hello,
            BusKind::State,
            BusKind::Action,
            BusKind::Request,
            BusKind::Reply,
        ] {
            assert!(
                has(&|e| e.kind == kind),
                "the fixture has no {kind:?} envelope"
            );
        }
        assert!(has(&|e| e.to == BusTarget::Role(BusRole::Shell)));
        assert!(has(&|e| e.to == BusTarget::Role(BusRole::Body)));
        assert!(has(&|e| matches!(e.to, BusTarget::Card { .. })));
        assert!(has(&|e| matches!(e.to, BusTarget::Page { .. })));
    }

    #[test]
    fn an_unknown_kind_fails_to_parse() {
        // `card-facts` is one of the kinds the bus spoke before the
        // envelope's five, and is refused like any stranger.
        for kind in ["card-gossip", "card-facts"] {
            let outbound = json!({"to": "shell", "kind": kind, "payload": {}});
            assert!(
                serde_json::from_value::<BusOutbound>(outbound).is_err(),
                "{kind} parsed"
            );
        }
    }

    #[test]
    fn a_target_is_a_role_a_card_or_a_page_and_never_all() {
        let target = |v: Value| serde_json::from_value::<BusTarget>(v).ok();
        assert_eq!(
            target(json!("shell")),
            Some(BusTarget::Role(BusRole::Shell))
        );
        assert_eq!(target(json!("body")), Some(BusTarget::Role(BusRole::Body)));
        assert_eq!(
            target(json!({"card": "c1"})),
            Some(BusTarget::Card { card: "c1".into() })
        );
        assert_eq!(
            target(json!({"page": "p1"})),
            Some(BusTarget::Page { page: "p1".into() })
        );
        assert_eq!(target(json!("all")), None);
        assert_eq!(target(json!("tool")), None);
    }

    #[test]
    fn an_envelope_passes_through_verbatim() {
        let outbound = json!({
            "to": {"card": "c1"},
            "kind": "state",
            "key": "card.context",
            "card": "c1",
            "version": 7,
            "ack": {"body-c1": 3},
            "payload": {"folded": false, "nested": [1, 2.5, null, {"x": "y"}]},
            "futureField": {"x": 1},
        });
        let parsed: BusOutbound = serde_json::from_value(outbound.clone()).expect("parses");
        let from = BusFrom {
            page_id: "shell-1".into(),
            role: BusRole::Shell,
            card_id: None,
        };
        let written = serde_json::to_value(parsed.deliver(from)).expect("serializes");
        let mut expected = outbound;
        expected["from"] = json!({"pageId": "shell-1", "role": "shell", "cardId": null});
        assert_eq!(written, expected);
    }

    #[test]
    fn an_outbound_message_ignores_the_from_a_page_wrote() {
        let outbound = json!({
            "from": {"pageId": "forged", "role": "shell", "cardId": null},
            "to": {"card": "c2"},
            "kind": "action",
            "key": "command",
            "payload": {"id": "find", "payload": {"query": "needle"}},
        });
        let parsed: BusOutbound = serde_json::from_value(outbound).expect("parses");
        assert_eq!(parsed.to, BusTarget::Card { card: "c2".into() });
        assert_eq!(parsed.kind, BusKind::Action);
        let from = BusFrom {
            page_id: "body-c1".into(),
            role: BusRole::Body,
            card_id: Some("c1".into()),
        };
        let written = serde_json::to_value(parsed.deliver(from)).expect("serializes");
        assert_eq!(written["from"]["pageId"], "body-c1");
        assert_eq!(
            written["payload"],
            json!({"id": "find", "payload": {"query": "needle"}})
        );
    }
}
