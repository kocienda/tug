//! DEFAULTS feed for tugcast.
//!
//! Pushes a single aggregated DEFAULTS frame — containing all domain snapshots
//! in one JSON object — to all WebSocket clients via a `watch::Sender<Frame>`.
//!
//! # Frame format
//!
//! Each DEFAULTS frame payload is a JSON object:
//! ```json
//! {
//!   "domains": {
//!     "dev.tugtool.deck.layout": {
//!       "generation": 42,
//!       "entries": {
//!         "layout": {"kind": "json", "value": {...}}
//!       }
//!     }
//!   }
//! }
//! ```
//!
//! The frame contains *all* domains on every send (not just changed ones),
//! because `watch::Sender` holds exactly one value and a partial update would
//! overwrite the prior complete state.
//!
//! # Design
//!
//! - [`defaults_feed`] accepts `Arc<TugbankClient>` and returns a
//!   `watch::Receiver<Frame>` that callers push into `snapshot_watches`.
//! - An `on_domain_changed` callback rebuilds the full aggregated frame on any
//!   domain change and sends it via `watch::Sender::send()`.
//! - The `CallbackHandle` is held in a spawned task that lives as long as the
//!   sender (i.e. until the receiver is dropped from `snapshot_watches`).

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Map, Value as JsonValue, json};
use tokio::sync::watch;
use tracing::{debug, warn};
use tugbank_core::TugbankClient;
use tugcast_core::{FeedId, Frame};

use crate::defaults::value_to_tagged;

/// Ceiling for the assembled DEFAULTS frame, held below the web client's
/// 16 MB transport cap (`protocol.ts` `MAX_PAYLOAD_SIZE`) with headroom for
/// the JSON wrapper. The web client drops an over-cap frame, which would
/// hang boot; rather than emit one, the builder sheds the largest domains
/// until the frame fits (logging each). A degraded boot missing a bloated
/// domain beats a launch that never completes.
const SAFE_DEFAULTS_FRAME_BYTES: usize = 14 * 1024 * 1024;

// ── Payload builder ───────────────────────────────────────────────────────────

/// Build an aggregated DEFAULTS frame from the current state of `client`.
///
/// Returns a serialised JSON payload `{"domains":{...}}` containing all
/// domains. On error (e.g. a domain fails to load), the domain is omitted and
/// a warning is logged.
fn build_defaults_frame(client: &TugbankClient) -> Frame {
    let mut domains = build_domain_entries(client);

    // Never emit an over-cap frame (the web client drops it and boot hangs).
    // Sum the per-domain sizes; if over budget, shed the largest domains
    // first — the many small critical domains (theme, layout, positions)
    // always fit, and only a pathologically bloated domain gets dropped.
    let approx = |name: &str, size: usize| name.len() + size + 8; // "name":<obj>,
    let mut total: usize = 16 + domains.iter().map(|(n, _, s)| approx(n, *s)).sum::<usize>();
    if total > SAFE_DEFAULTS_FRAME_BYTES {
        domains.sort_by(|a, b| b.2.cmp(&a.2)); // largest first
        while total > SAFE_DEFAULTS_FRAME_BYTES && !domains.is_empty() {
            let (name, _, size) = domains.remove(0);
            total -= approx(&name, size);
            warn!(
                domain = %name,
                bytes = size,
                "defaults_feed: shedding oversized domain from boot frame (would exceed transport cap)"
            );
        }
    }

    let mut domains_map = Map::new();
    for (name, obj, _) in domains {
        domains_map.insert(name, obj);
    }
    let payload = json!({"domains": domains_map});
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    Frame::new(FeedId::DEFAULTS, bytes)
}

/// Serialise each domain into `(name, json, serialized_byte_len)`. The size
/// is the domain object's own JSON length — used by the frame builder to
/// keep the aggregate under the transport cap.
fn build_domain_entries(client: &TugbankClient) -> Vec<(String, JsonValue, usize)> {
    let mut out: Vec<(String, JsonValue, usize)> = Vec::new();

    let domain_names = match client.list_domains() {
        Ok(names) => names,
        Err(e) => {
            warn!(error = %e, "defaults_feed: failed to list domains");
            return out;
        }
    };

    for domain_name in &domain_names {
        let snapshot: BTreeMap<String, tugbank_core::Value> = match client.read_domain(domain_name)
        {
            Ok(snap) => snap,
            Err(e) => {
                warn!(domain = %domain_name, error = %e, "defaults_feed: failed to read domain");
                continue;
            }
        };

        // Get generation from the store.
        let generation: u64 = client
            .store()
            .domain(domain_name)
            .and_then(|h| h.generation())
            .unwrap_or(0);

        let mut entries = Map::new();
        for (key, value) in &snapshot {
            let tagged = value_to_tagged(value);
            if let Ok(v) = serde_json::to_value(&tagged) {
                entries.insert(key.clone(), v);
            }
        }

        let domain_obj = json!({
            "generation": generation,
            "entries": entries,
        });
        let size = serde_json::to_vec(&domain_obj)
            .map(|b| b.len())
            .unwrap_or(0);
        out.push((domain_name.clone(), domain_obj, size));
    }

    out
}

// ── defaults_feed ─────────────────────────────────────────────────────────────

/// Start the DEFAULTS feed.
///
/// Builds and sends an initial aggregated DEFAULTS frame, registers a
/// domain-changed callback that rebuilds and sends the full frame on every
/// change, and returns a `watch::Receiver<Frame>` for wiring into
/// `snapshot_watches`.
///
/// The returned receiver (and by extension the `watch::Sender` inside) lives
/// until all receivers are dropped. The `CallbackHandle` is kept alive inside
/// a spawned task that holds a clone of the sender, so the callback fires as
/// long as the feed is alive.
pub fn defaults_feed(client: Arc<TugbankClient>) -> watch::Receiver<Frame> {
    // Build the initial frame before registering the callback so the
    // first value is always a complete snapshot.
    let initial_frame = build_defaults_frame(&client);
    let (tx, rx) = watch::channel(initial_frame);
    debug!("defaults_feed: initial frame sent");

    // Spawn a task that holds both the sender and the callback handle.
    // The callback captures a clone of the sender and a clone of the client Arc.
    // When the task exits, both the handle (unregistering the callback) and the
    // sender clone are dropped.
    let task_tx = tx.clone();
    tokio::spawn(async move {
        // Clones for the callback closure (which must be 'static + Send).
        let cb_client = Arc::clone(&client);
        let cb_tx = task_tx.clone();

        // Register the change callback. The handle keeps the callback alive.
        let _handle = client.on_domain_changed(move |domain, _snapshot| {
            debug!(domain = %domain, "defaults_feed: domain changed, rebuilding frame");
            let frame = build_defaults_frame(&cb_client);
            if cb_tx.send(frame).is_err() {
                // All receivers dropped — feed is no longer consumed.
                debug!("defaults_feed: all receivers dropped, callback is stale");
            }
        });

        // Keep the task alive until the watch channel is fully closed.
        task_tx.closed().await;
        debug!("defaults_feed: channel closed, task exiting");
    });

    rx
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use tugbank_core::{TugbankClient, Value};

    /// test_defaults_feed_aggregates_all_domains:
    ///
    /// Create a TugbankClient with two domains, call defaults_feed, verify the
    /// initial watch::Receiver value contains both domains in a single frame.
    #[tokio::test]
    async fn test_defaults_feed_aggregates_all_domains() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");

        // Write two domains.
        client
            .set("domain.alpha", "key1", Value::String("hello".into()))
            .expect("set alpha");
        client
            .set("domain.beta", "key2", Value::I64(42))
            .expect("set beta");

        let client_arc = Arc::new(client);
        let rx = defaults_feed(Arc::clone(&client_arc));

        // The initial frame should contain both domains.
        let frame = rx.borrow().clone();
        assert_eq!(frame.feed_id, FeedId::DEFAULTS);
        assert!(!frame.payload.is_empty(), "payload should not be empty");

        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).expect("valid JSON");
        let domains = parsed
            .get("domains")
            .expect("domains key")
            .as_object()
            .expect("domains is object");

        assert!(domains.contains_key("domain.alpha"), "missing domain.alpha");
        assert!(domains.contains_key("domain.beta"), "missing domain.beta");

        // Verify domain.alpha has the expected entry.
        let alpha = &domains["domain.alpha"];
        let alpha_entries = alpha.get("entries").expect("entries").as_object().unwrap();
        assert!(alpha_entries.contains_key("key1"), "missing key1 in alpha");

        // Verify domain.beta has the expected entry.
        let beta = &domains["domain.beta"];
        let beta_entries = beta.get("entries").expect("entries").as_object().unwrap();
        assert!(beta_entries.contains_key("key2"), "missing key2 in beta");
    }

    /// A domain that alone would blow the frame past the transport cap is
    /// shed, while the small critical domains survive — the frame stays
    /// under the cap so the web client never drops it (which would hang boot).
    #[tokio::test]
    async fn test_oversized_domain_is_shed_from_frame() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");

        // A small critical domain that must always fit.
        client
            .set("dev.tugtool.app", "theme", Value::String("brio".into()))
            .expect("set app");
        // A single domain larger than the whole safe frame budget. The name is
        // synthetic: the shed is a property of the frame builder, not of any
        // particular domain, and no shipping domain is expected to reach it.
        let huge = "x".repeat(SAFE_DEFAULTS_FRAME_BYTES + 1024);
        client
            .set("dev.tugtool.test.bloat", "s1", Value::String(huge))
            .expect("set bloat");

        let frame = build_defaults_frame(&client);
        assert!(
            frame.payload.len() <= SAFE_DEFAULTS_FRAME_BYTES,
            "frame ({} bytes) must stay under the safe cap",
            frame.payload.len()
        );

        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).expect("valid JSON");
        let domains = parsed
            .get("domains")
            .expect("domains key")
            .as_object()
            .expect("domains is object");
        assert!(
            domains.contains_key("dev.tugtool.app"),
            "small critical domain must survive the shed"
        );
        assert!(
            !domains.contains_key("dev.tugtool.test.bloat"),
            "oversized domain must be shed from the boot frame"
        );
    }
}
