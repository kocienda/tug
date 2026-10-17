//! The deck bus: addressed messages between pages.
//!
//! `DECK_BUS` (0xD0) carries one JSON envelope per frame. A page sends a
//! [`BusOutbound`] — a target and a message — and tugcast delivers a
//! [`BusDelivered`], which adds the sender as tugcast registered it, so a
//! page cannot speak as another. These types are the Rust half of
//! `tugproto/src/bus.ts`, and both halves are held to
//! `tugproto/src/__tests__/fixtures/bus-parity.json`.
//!
//! The vocabulary is closed: a `kind` this module does not name fails to
//! parse. Each kind's direction (`card-facts` and `card-advice` body →
//! shell, `card-command` shell → body, `deck-facts` shell → bodies,
//! `card-context` shell → one body) is its documented use; the router does
//! not enforce it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A page role a bus message can be addressed to. A tool is never one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BusRole {
    /// The newest live shell page.
    Shell,
    /// Every live body page.
    Body,
}

/// Whom a bus message is for: `"shell"`, `"body"`, `{"card": "<id>"}` or
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

/// `card-facts`: what a card shows the chrome about itself.
///
/// `masthead` is the deck's `CardMastheadPayload` object (or null), carried
/// opaquely: tugcast routes it and never reads it. `activity` is the session
/// phase key `useSessionPhase` computes; `telemetry` carries `canInterrupt`
/// and `compacted` as 0 or 1.
/// `identity` is the card's live identity facts as its own page resolves
/// them (`CardIdentityFacts`), carried opaquely like `masthead`.
/// `titleBar` is the controls the card contributes to its pane's title bar,
/// each with its enablement as the card's own chain answers; opaque here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFacts {
    pub title: String,
    pub masthead: Option<serde_json::Value>,
    pub activity: Option<String>,
    pub telemetry: BTreeMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_bar: Option<serde_json::Value>,
}

/// What a `card-command` asks a card to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardCommandKind {
    Find,
    FocusPrompt,
    Interrupt,
    TurnPrevious,
    TurnNext,
    Chord,
    /// A card-scoped menu command, by its action id.
    Dispatch,
    /// The Tab walk enters the card at its first or last stop.
    FocusEnter,
    /// The user pressed something in the card's surface the shell draws.
    SurfaceActivate,
    /// The shell dismissed the card's surface it draws.
    SurfaceDismissed,
    /// The shell asks the card's own close guard to decide.
    CloseDecision,
    /// Start or stop publishing the card's session inspection (`on`).
    Inspect,
    /// A followed card's inspection, relayed to a devtools card.
    Inspection,
    /// A chain action, by `id`, sent to the card's content responder.
    ContentAction,
    /// Reveal a line of the card's file (`payload`: `line`, `endLine`, `columns`).
    RevealLine,
    /// Show a section of the Settings card (`payload`: `section`).
    RevealSettings,
    /// The shell's dev log for the devtools card (`payload`: `entries`), opaque here.
    DevLog,
    /// A session the shell decided for a card already in its body (`payload`: the intent), opaque here.
    Intent,
    /// Capture a jot in the Jots card: create an empty one and open its editor.
    NewJot,
}

/// Where a `focus-enter` lands the keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FocusEdge {
    First,
    Last,
}

/// Which way a card's Tab walk left it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FocusDirection {
    Next,
    Previous,
}

/// A key chord a `card-command` forwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusChord {
    pub key: String,
    pub modifiers: Vec<String>,
}

/// `card-command`: the chrome asking a card to act.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCommand {
    pub command: CardCommandKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chord: Option<BusChord>,
    /// The action id a `dispatch` command carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The action's payload, for a `dispatch` that has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    /// Where a `focus-enter` lands the keyboard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge: Option<FocusEdge>,
    /// The element a `surface-activate` presses, by its child-index path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<u32>>,
    /// Whether an `inspect` starts the card's inspection or stops it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
    /// The inspection an `inspection` relays, opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspection: Option<serde_json::Value>,
}

/// Which way a surface the shell draws opens off its line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceGrowth {
    Up,
    Down,
}

/// Where a scroller in a drawn surface stood, by its child-index path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceScroll {
    pub path: Vec<u32>,
    pub top: f64,
}

/// A surface a body asks the shell to draw over the deck: its content as
/// the body rendered it, hung off a line in the body's viewport points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSurface {
    pub title: String,
    pub class_name: String,
    pub growth: SurfaceGrowth,
    pub anchor_x: f64,
    pub line_y: f64,
    pub html: String,
    pub scroll: Vec<SurfaceScroll>,
}

/// `card-advice`: what a card tells the chrome about how to treat it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "advice", rename_all = "kebab-case")]
pub enum CardAdvice {
    #[serde(rename_all = "camelCase")]
    FoldGuard { guarded: bool },
    /// `waive`: the card asks the chrome to close without confirming.
    #[serde(rename_all = "camelCase")]
    CloseAdvice { waive: bool },
    /// The height the card's sheet reserves, or null to release it.
    #[serde(rename_all = "camelCase")]
    SheetReservation { height_px: Option<f64> },
    /// The height the card bids to open at, or null to withdraw the bid.
    #[serde(rename_all = "camelCase")]
    OpeningBid { height_px: Option<f64> },
    /// The card asks to be made the key card.
    Activate,
    /// The card's first frame of content has gone to the compositor, said
    /// behind every `card-facts` that frame was drawn with.
    Painted,
    /// The card asks the chrome to close it.
    CloseRequest,
    /// The card asks for a card of `component_id` added to the pane it
    /// stands in — the pane's `add-tab` currency, which is not a command.
    #[serde(rename_all = "camelCase")]
    AddCard { component_id: String },
    /// A command the body's chain did not handle, for the shell to
    /// dispatch in its own chain.
    Dispatch {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    /// The card's Tab walk reached its edge; `empty` says it answered a
    /// `focus-enter` with no stop to take.
    FocusExit {
        direction: FocusDirection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        empty: Option<bool>,
    },
    /// The card's deck-scope surface for the shell to draw, or null to stop.
    Surface { surface: Option<ShellSurface> },
    /// The card asked to log out.
    Logout,
    /// A deck method an arrangement card called, for the shell to run when
    /// it lets a body call that method.
    DeckCall {
        method: String,
        args: Vec<serde_json::Value>,
    },
    /// Whether the card's own close guard would ask before it closes.
    CloseGuard { asks: bool },
    /// The card's close guard decided: `close` or `cancel`.
    CloseDecision { answer: CloseAnswer },
    /// The card's chord capture armed or disarmed: the host parks the menu
    /// bar's key equivalents while a capture records, and the menu state is
    /// the shell's to push.
    CaptureArmed { armed: bool },
    /// The card's session inspection, opaque here.
    Inspection { inspection: serde_json::Value },
}

/// What a card's close guard decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseAnswer {
    Close,
    Cancel,
}

/// `deck-facts`: what the chrome tells every card about the deck.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckFacts {
    pub theme: String,
    pub zoom: f64,
    pub keyboard_access: bool,
    pub modifier_latch: Vec<String>,
    /// The app's focus-ring modality, which a body follows.
    pub focus_ring_modality: FocusRingModality,
    pub app_active: bool,
    /// The shell's menu projection for its bodies, opaque here: the deck's
    /// arrangement as the shell's menu publisher projects it, and the focus
    /// family's travel. Absent until the shell has projected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu: Option<serde_json::Value>,
    /// The deck's frontmost bound card's binding (`binding`, null when none),
    /// opaque here: the project a card with no session of its own resolves
    /// a relative path against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmost_project: Option<serde_json::Value>,
}

/// Whether the focus ring follows the keyboard only, or the pointer too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FocusRingModality {
    Keyboard,
    Pointer,
}

/// `card-context`: what the chrome tells one body about its own card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardContext {
    pub folded: bool,
    pub arriving: bool,
    pub first_responder_card_id: Option<String>,
    pub layer_shown: bool,
    pub space_id: Option<String>,
    /// The shell's arrangement, for an arrangement kind; opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrangement: Option<serde_json::Value>,
    /// The card a following kind follows, and its binding; opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub followed: Option<serde_json::Value>,
    /// The app's build identity, for the About card; opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_info: Option<serde_json::Value>,
    /// The deck edge a pinned rail card stands on; absent for any other card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_side: Option<RailSide>,
    /// The crossing the card's pane stands under, for the body to hold its
    /// card root through; opaque here, absent when none stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crossing: Option<serde_json::Value>,
}

/// A deck edge a rail stands pinned to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RailSide {
    Left,
    Right,
}

/// One bus message: a `kind` and its `payload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "kebab-case")]
pub enum BusMessage {
    CardFacts(CardFacts),
    CardCommand(CardCommand),
    CardAdvice(CardAdvice),
    DeckFacts(DeckFacts),
    CardContext(CardContext),
}

/// The sender of a delivered message, stamped by tugcast from the identity
/// the sender's hello registered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusFrom {
    pub page_id: String,
    pub role: BusRole,
    pub card_id: Option<String>,
}

/// A message as a page sends it. A `from` the page wrote is ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BusOutbound {
    pub to: BusTarget,
    #[serde(flatten)]
    pub message: BusMessage,
}

/// A message as tugcast delivers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BusDelivered {
    pub from: BusFrom,
    pub to: BusTarget,
    #[serde(flatten)]
    pub message: BusMessage,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tugproto/src/__tests__/fixtures/bus-parity.json"
        );
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        serde_json::from_str(&text).expect("bus-parity.json is JSON")
    }

    /// Every number as an `f64`, so `480` in the fixture and the `480.0` an
    /// `f64` field writes back compare equal.
    fn numbers_as_floats(value: Value) -> Value {
        match value {
            Value::Number(n) => json!(n.as_f64().expect("a finite number")),
            Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_floats).collect()),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| (k, numbers_as_floats(v)))
                    .collect(),
            ),
            other => other,
        }
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
                numbers_as_floats(written),
                numbers_as_floats(envelope.clone()),
                "{envelope} does not survive a round trip"
            );
        }
    }

    #[test]
    fn the_fixture_names_every_kind_advice_and_target() {
        let fixture = fixture();
        let envelopes: Vec<BusDelivered> =
            serde_json::from_value(fixture["delivered"].clone()).expect("parses");
        let has = |pred: &dyn Fn(&BusDelivered) -> bool| envelopes.iter().any(pred);
        assert!(has(&|e| matches!(e.message, BusMessage::CardFacts(_))));
        assert!(has(&|e| matches!(e.message, BusMessage::CardCommand(_))));
        assert!(has(&|e| matches!(e.message, BusMessage::DeckFacts(_))));
        assert!(has(&|e| matches!(e.message, BusMessage::CardContext(_))));
        assert!(has(&|e| matches!(
            &e.message,
            BusMessage::CardCommand(CardCommand {
                command: CardCommandKind::Dispatch,
                id: Some(_),
                ..
            })
        )));
        for advice in [
            "fold-guard",
            "close-advice",
            "sheet-reservation",
            "opening-bid",
            "activate",
            "painted",
            "close-request",
            "add-card",
            "dispatch",
            "focus-exit",
            "surface",
            "logout",
            "deck-call",
            "close-guard",
            "close-decision",
            "capture-armed",
            "inspection",
        ] {
            assert!(
                has(&|e| match &e.message {
                    BusMessage::CardAdvice(a) => {
                        serde_json::to_value(a).unwrap()["advice"] == advice
                    }
                    _ => false,
                }),
                "the fixture has no {advice} advice"
            );
        }
        assert!(has(&|e| e.to == BusTarget::Role(BusRole::Shell)));
        for command in [
            CardCommandKind::CloseDecision,
            CardCommandKind::Inspect,
            CardCommandKind::Inspection,
            CardCommandKind::ContentAction,
            CardCommandKind::RevealLine,
            CardCommandKind::RevealSettings,
            CardCommandKind::DevLog,
            CardCommandKind::Intent,
            CardCommandKind::NewJot,
        ] {
            assert!(
                has(&|e| matches!(&e.message, BusMessage::CardCommand(c) if c.command == command)),
                "the fixture has no {command:?} command"
            );
        }
        assert!(has(&|e| matches!(
            &e.message,
            BusMessage::CardContext(CardContext {
                arrangement: Some(_),
                followed: Some(_),
                app_info: Some(_),
                ..
            })
        )));
        assert!(has(&|e| e.to == BusTarget::Role(BusRole::Body)));
        assert!(has(&|e| matches!(e.to, BusTarget::Card { .. })));
        assert!(has(&|e| matches!(e.to, BusTarget::Page { .. })));
    }

    #[test]
    fn an_unknown_kind_fails_to_parse() {
        let outbound = json!({"to": "shell", "kind": "card-gossip", "payload": {}});
        assert!(serde_json::from_value::<BusOutbound>(outbound).is_err());
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
    fn an_outbound_message_ignores_the_from_a_page_wrote() {
        let outbound = json!({
            "from": {"pageId": "forged", "role": "shell", "cardId": null},
            "to": {"card": "c2"},
            "kind": "card-command",
            "payload": {"command": "find", "query": "needle"},
        });
        let parsed: BusOutbound = serde_json::from_value(outbound).expect("parses");
        assert_eq!(parsed.to, BusTarget::Card { card: "c2".into() });
        assert_eq!(
            parsed.message,
            BusMessage::CardCommand(CardCommand {
                command: CardCommandKind::Find,
                query: Some("needle".into()),
                chord: None,
                id: None,
                payload: None,
                edge: None,
                path: None,
                on: None,
                inspection: None,
            })
        );
        assert!(serde_json::to_value(&parsed).unwrap().get("from").is_none());
    }
}
