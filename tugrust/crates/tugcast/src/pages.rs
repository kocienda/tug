//! The page registry: which page is on each WebSocket.
//!
//! One `Arc<PageRegistry>` is made at boot and shared by the router (which
//! registers a page after its handshake and departs it at teardown), the
//! supervisor, and every service that keeps per-page state. A connection's
//! identity comes from its hello ([`tugcast_core::parse_page_hello`]); a
//! connection that said nothing is registered as a `tool`.
//!
//! Departures are published on a broadcast channel so a service holding
//! per-page state can drop it when the page leaves. The registry also
//! remembers when each card's last body page departed, so a body that is
//! reloading — between its old socket and its new one — is not taken for a
//! card nobody has.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;
use tugcast_core::{Frame, PageIdentity, PageRole};

/// Capacity of the departures channel. A receiver that lags reconciles
/// against [`PageRegistry::snapshot`] rather than guessing.
const DEPARTURES_CAPACITY: usize = 64;

/// Which connections a frame is for, resolved to client ids when it is
/// published. A connection's forwarder admits a frame only when its own id is
/// named; `All` and `AllExcept` are the deliveries that reach tools.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Delivery {
    All,
    Client(u64),
    Clients(Arc<[u64]>),
    /// Every connection but these: what a feed that serves its pages one by
    /// one sends the connections it does not serve, tools among them.
    AllExcept(Arc<[u64]>),
}

impl Delivery {
    /// Whether the connection `client_id` receives a frame with this delivery.
    pub(crate) fn admits(&self, client_id: u64) -> bool {
        match self {
            Delivery::All => true,
            Delivery::Client(id) => *id == client_id,
            Delivery::Clients(ids) => ids.contains(&client_id),
            Delivery::AllExcept(ids) => !ids.contains(&client_id),
        }
    }
}

/// Who a frame is meant for, before it is resolved against the live pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PageTarget {
    /// Every connection, tools included.
    All,
    /// The newest live shell page.
    Shell,
    /// Every live body page.
    Bodies,
    /// The newest live page rendering this card.
    Card(String),
    /// The live page with this page id.
    Page(String),
}

impl fmt::Display for PageTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PageTarget::All => f.write_str("all"),
            PageTarget::Shell => f.write_str("shell"),
            PageTarget::Bodies => f.write_str("body"),
            PageTarget::Card(card) => write!(f, "card {card}"),
            PageTarget::Page(page) => write!(f, "page {page}"),
        }
    }
}

/// Read a target's wire spelling: `"shell"`, `"all"`, `"body"`,
/// `{"card": "<id>"}` or `{"page": "<page_id>"}`. Anything else is `None`.
pub(crate) fn parse_target(value: &serde_json::Value) -> Option<PageTarget> {
    match value {
        serde_json::Value::String(s) => match s.as_str() {
            "shell" => Some(PageTarget::Shell),
            "all" => Some(PageTarget::All),
            "body" => Some(PageTarget::Bodies),
            _ => None,
        },
        serde_json::Value::Object(obj) if obj.len() == 1 => {
            if let Some(card) = obj.get("card").and_then(|c| c.as_str()) {
                Some(PageTarget::Card(card.to_owned()))
            } else {
                obj.get("page")
                    .and_then(|p| p.as_str())
                    .map(|p| PageTarget::Page(p.to_owned()))
            }
        }
        _ => None,
    }
}

/// A frame and the connections it is for. Published on an addressed lane;
/// the frame's own bytes are never rewritten.
#[derive(Debug, Clone)]
pub(crate) struct AddressedFrame {
    pub(crate) to: Delivery,
    pub(crate) frame: Frame,
}

/// An input frame and the connection that sent it. The router sets
/// `client_id`, so a page cannot answer as another.
#[derive(Debug, Clone)]
pub(crate) struct ClientFrame {
    pub(crate) client_id: u64,
    pub(crate) frame: Frame,
}

/// Every id in `ids`, as one delivery. An empty set is a delivery to
/// nobody, which every forwarder refuses.
pub(crate) fn deliver_to(ids: impl IntoIterator<Item = u64>) -> Delivery {
    let mut ids: Vec<u64> = ids.into_iter().collect();
    ids.sort_unstable();
    Delivery::Clients(ids.into())
}

/// Which sessions a page receives session-scoped frames for.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) enum SessionSubscription {
    /// Every session. The state of a page that has never narrowed it.
    #[default]
    All,
    /// Exactly these `tug_session_id`s; an empty set means none.
    Only(HashSet<String>),
}

impl SessionSubscription {
    /// Does this subscription take frames for `session`?
    pub(crate) fn admits(&self, session: &str) -> bool {
        match self {
            SessionSubscription::All => true,
            SessionSubscription::Only(set) => set.contains(session),
        }
    }
}

impl Serialize for SessionSubscription {
    /// `null` for all, a sorted array otherwise — the same spelling
    /// `feed_stats` uses for its feed set.
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            SessionSubscription::All => s.serialize_none(),
            SessionSubscription::Only(set) => {
                let mut ids: Vec<&String> = set.iter().collect();
                ids.sort();
                ids.serialize(s)
            }
        }
    }
}

/// One live connection, as the registry knows it.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PageRecord {
    pub(crate) client_id: u64,
    pub(crate) role: PageRole,
    pub(crate) page_id: Option<String>,
    pub(crate) card_id: Option<String>,
    pub(crate) connected_at_ms: u64,
    pub(crate) sessions: SessionSubscription,
}

struct Inner {
    pages: BTreeMap<u64, PageRecord>,
    /// When each card's body page last departed.
    departed_cards: HashMap<String, Instant>,
}

/// Every live connection's identity, keyed by `client_id`.
pub(crate) struct PageRegistry {
    inner: Mutex<Inner>,
    departures: broadcast::Sender<u64>,
}

impl Default for PageRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PageRegistry {
    pub(crate) fn new() -> Self {
        let (departures, _) = broadcast::channel(DEPARTURES_CAPACITY);
        Self {
            inner: Mutex::new(Inner {
                pages: BTreeMap::new(),
                departed_cards: HashMap::new(),
            }),
            departures,
        }
    }

    /// Record a connection that has completed its handshake.
    pub(crate) fn register(&self, client_id: u64, identity: &PageIdentity) {
        let record = PageRecord {
            client_id,
            role: identity.role,
            page_id: identity.page_id.clone(),
            card_id: identity.card_id.clone(),
            connected_at_ms: now_ms(),
            sessions: SessionSubscription::All,
        };
        self.inner.lock().pages.insert(client_id, record);
    }

    /// Remove a connection. A body's card is remembered as departed now, and
    /// the client id is published to every departures receiver. Departing an
    /// id the registry does not hold (a connection whose handshake failed)
    /// does nothing and publishes nothing.
    pub(crate) fn depart(&self, client_id: u64) {
        {
            let mut inner = self.inner.lock();
            let Some(record) = inner.pages.remove(&client_id) else {
                return;
            };
            if record.role == PageRole::Body {
                if let Some(card) = record.card_id {
                    inner.departed_cards.insert(card, Instant::now());
                }
            }
        }
        // No receiver is not an error: a service that keeps per-page state
        // may not have started yet.
        let _ = self.departures.send(client_id);
    }

    /// Record which sessions a page's `subscribe_feeds` asked for. An id
    /// the registry does not hold is ignored.
    pub(crate) fn set_sessions(&self, client_id: u64, sessions: SessionSubscription) {
        if let Some(record) = self.inner.lock().pages.get_mut(&client_id) {
            record.sessions = sessions;
        }
    }

    /// A receiver of departed client ids.
    pub(crate) fn departures(&self) -> broadcast::Receiver<u64> {
        self.departures.subscribe()
    }

    /// Every live page, sorted by `client_id`.
    pub(crate) fn snapshot(&self) -> Vec<PageRecord> {
        self.inner.lock().pages.values().cloned().collect()
    }

    /// Resolve a target against the live pages. Where two live pages answer
    /// one target — two shells, or a body reloading before its old socket is
    /// gone — the newest, which has the highest `client_id`, is the one
    /// addressed. `None` means no live page answers.
    pub(crate) fn resolve(&self, target: &PageTarget) -> Option<Delivery> {
        let inner = self.inner.lock();
        let newest = |pred: &dyn Fn(&PageRecord) -> bool| {
            inner
                .pages
                .values()
                .rev()
                .find(|p| pred(p))
                .map(|p| Delivery::Client(p.client_id))
        };
        match target {
            PageTarget::All => Some(Delivery::All),
            PageTarget::Shell => newest(&|p| p.role == PageRole::Shell),
            PageTarget::Card(card) => {
                newest(&|p| p.role != PageRole::Tool && p.card_id.as_deref() == Some(card.as_str()))
            }
            PageTarget::Page(page) => {
                newest(&|p| p.role != PageRole::Tool && p.page_id.as_deref() == Some(page.as_str()))
            }
            PageTarget::Bodies => {
                let ids: Vec<u64> = inner
                    .pages
                    .values()
                    .filter(|p| p.role == PageRole::Body)
                    .map(|p| p.client_id)
                    .collect();
                (!ids.is_empty()).then(|| Delivery::Clients(ids.into()))
            }
        }
    }

    /// Whether `card` has a live page, or had a body page that departed less
    /// than `window` ago.
    pub(crate) fn card_live_or_recent(&self, card: &str, window: Duration) -> bool {
        let inner = self.inner.lock();
        if inner
            .pages
            .values()
            .any(|p| p.card_id.as_deref() == Some(card))
        {
            return true;
        }
        inner
            .departed_cards
            .get(card)
            .is_some_and(|at| at.elapsed() < window)
    }

    /// Move a card's recorded departure `by` into the past, so a test can
    /// read the settle window without waiting it out.
    #[cfg(test)]
    pub(crate) fn backdate_departure(&self, card: &str, by: Duration) {
        if let Some(at) = self.inner.lock().departed_cards.get_mut(card) {
            *at -= by;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(page: &str) -> PageIdentity {
        PageIdentity {
            role: PageRole::Shell,
            page_id: Some(page.into()),
            card_id: None,
        }
    }

    fn body(page: &str, card: &str) -> PageIdentity {
        PageIdentity {
            role: PageRole::Body,
            page_id: Some(page.into()),
            card_id: Some(card.into()),
        }
    }

    #[test]
    fn register_and_depart_round_trip() {
        let reg = PageRegistry::new();
        reg.register(3, &shell("p3"));
        let snap = reg.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].client_id, 3);
        assert_eq!(snap[0].role, PageRole::Shell);
        assert_eq!(snap[0].page_id.as_deref(), Some("p3"));
        assert!(snap[0].connected_at_ms > 0);
        reg.depart(3);
        assert!(reg.snapshot().is_empty());
    }

    #[test]
    fn departing_a_body_records_its_card_and_broadcasts_the_id() {
        let reg = PageRegistry::new();
        let mut rx = reg.departures();
        reg.register(5, &body("p5", "c1"));
        assert!(reg.card_live_or_recent("c1", Duration::from_secs(60)));
        reg.depart(5);
        assert_eq!(rx.try_recv().unwrap(), 5);
        assert!(reg.card_live_or_recent("c1", Duration::from_secs(60)));
        assert!(!reg.card_live_or_recent("c1", Duration::ZERO));
        assert!(!reg.card_live_or_recent("c2", Duration::from_secs(60)));
    }

    #[test]
    fn departing_an_unknown_id_publishes_nothing() {
        let reg = PageRegistry::new();
        let mut rx = reg.departures();
        reg.depart(9);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn snapshot_is_sorted_by_client_id() {
        let reg = PageRegistry::new();
        reg.register(7, &PageIdentity::tool());
        reg.register(2, &shell("a"));
        reg.register(4, &body("b", "c"));
        let ids: Vec<u64> = reg.snapshot().iter().map(|p| p.client_id).collect();
        assert_eq!(ids, vec![2, 4, 7]);
    }

    #[test]
    fn resolve_picks_the_newest_shell_and_card_page_and_never_a_tool() {
        let reg = PageRegistry::new();
        reg.register(2, &shell("old-shell"));
        reg.register(3, &body("b1", "c1"));
        reg.register(5, &shell("new-shell"));
        reg.register(6, &PageIdentity::tool());
        reg.register(7, &body("b1-reloaded", "c1"));
        reg.register(8, &body("b2", "c2"));

        assert_eq!(reg.resolve(&PageTarget::Shell), Some(Delivery::Client(5)));
        assert_eq!(
            reg.resolve(&PageTarget::Card("c1".into())),
            Some(Delivery::Client(7))
        );
        assert_eq!(
            reg.resolve(&PageTarget::Page("b2".into())),
            Some(Delivery::Client(8))
        );
        assert_eq!(
            reg.resolve(&PageTarget::Bodies),
            Some(Delivery::Clients(vec![3, 7, 8].into()))
        );
        assert_eq!(reg.resolve(&PageTarget::All), Some(Delivery::All));
        assert_eq!(reg.resolve(&PageTarget::Card("c9".into())), None);
    }

    #[test]
    fn resolve_answers_none_when_no_live_page_answers() {
        let reg = PageRegistry::new();
        reg.register(1, &PageIdentity::tool());
        assert_eq!(reg.resolve(&PageTarget::Shell), None);
        assert_eq!(reg.resolve(&PageTarget::Bodies), None);
        reg.register(2, &shell("s"));
        reg.depart(2);
        assert_eq!(reg.resolve(&PageTarget::Shell), None);
    }

    #[test]
    fn delivery_admits_only_whom_it_names() {
        assert!(Delivery::All.admits(1) && Delivery::All.admits(99));
        assert!(Delivery::Client(4).admits(4));
        assert!(!Delivery::Client(4).admits(5));
        let some = Delivery::Clients(vec![2, 3].into());
        assert!(some.admits(2) && some.admits(3) && !some.admits(4));
        let rest = Delivery::AllExcept(vec![2, 3].into());
        assert!(!rest.admits(2) && !rest.admits(3) && rest.admits(4));
    }

    #[test]
    fn parse_target_reads_every_wire_spelling() {
        use serde_json::json;
        assert_eq!(parse_target(&json!("shell")), Some(PageTarget::Shell));
        assert_eq!(parse_target(&json!("all")), Some(PageTarget::All));
        assert_eq!(parse_target(&json!("body")), Some(PageTarget::Bodies));
        assert_eq!(
            parse_target(&json!({"card": "c1"})),
            Some(PageTarget::Card("c1".into()))
        );
        assert_eq!(
            parse_target(&json!({"page": "p1"})),
            Some(PageTarget::Page("p1".into()))
        );
        assert_eq!(parse_target(&json!("bodies")), None);
        assert_eq!(parse_target(&json!({"card": 3})), None);
        assert_eq!(parse_target(&json!({"card": "c", "page": "p"})), None);
        assert_eq!(parse_target(&json!(7)), None);
    }

    #[test]
    fn session_subscription_serializes_null_or_sorted() {
        assert_eq!(
            serde_json::to_value(SessionSubscription::All).unwrap(),
            serde_json::Value::Null
        );
        let only = SessionSubscription::Only(["b".to_string(), "a".to_string()].into());
        assert_eq!(
            serde_json::to_value(only).unwrap(),
            serde_json::json!(["a", "b"])
        );
    }
}
