//! End-to-end proof for the per-connection send gate's telemetry and, in
//! later steps, for the `subscribe_feeds` filter it gates on.
//!
//! Spins up a real `tugcast` subprocess, connects a WebSocket client, and
//! asks the router what it thinks it sent — then checks that answer against
//! what the client actually received. The counters live on the one gate
//! every server-to-client frame passes through, so a site that escaped the
//! funnel would show up here as an under-count rather than as nothing at all.
//!
//! Needs only `git` + the harness's `tmux` session; no `claude`, so it runs
//! in the default suite.
//!
//! Run: `cargo nextest run -p tugcast --test feed_subscriptions`

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use tempfile::{NamedTempFile, TempDir};
use tugcast_core::FeedId;

mod common;
use common::{TestTugcast, TestWs};

const WIRE_TIMEOUT: Duration = Duration::from_secs(10);

/// Run a git subcommand in `repo`, asserting success.
fn git(repo: &Path, args: &[&str]) {
    let mut full = vec!["-C", repo.to_str().unwrap()];
    full.extend_from_slice(args);
    let out = Command::new("git").args(&full).output().expect("run git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A committed one-file repo — enough for tugcast to resolve a bootstrap
/// workspace and start pushing its snapshot feeds.
fn make_repo() -> TempDir {
    let temp = TempDir::new().expect("repo tempdir");
    let repo = temp.path();
    git(repo, &["init"]);
    git(repo, &["config", "user.name", "test"]);
    git(repo, &["config", "user.email", "test@test.com"]);
    std::fs::write(repo.join("a.txt"), "stable\n").unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", "init"]);
    temp
}

/// Find the row for `feed` in one of the response's two tables.
fn stats_row(table: &serde_json::Value, feed: u8) -> Option<&serde_json::Value> {
    table
        .as_array()
        .expect("table is an array")
        .iter()
        .find(|r| r["feed"] == feed)
}

#[tokio::test]
async fn feed_stats_counts_exactly_what_the_connection_received() {
    let repo = make_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    // Wait for real traffic before asking, so the assertion below has
    // something to be true about.
    let feed = ws
        .await_any_data_feed(WIRE_TIMEOUT)
        .await
        .expect("some snapshot feed to arrive");

    ws.send_control_payload(serde_json::json!({ "action": "feed_stats" }))
        .await;
    let (stats, census) = ws
        .await_control_type("feed_stats", WIRE_TIMEOUT)
        .await
        .expect("feed_stats response");

    assert_eq!(stats["type"], "feed_stats");
    assert!(
        stats["client_id"].as_u64().is_some_and(|id| id >= 1),
        "the response names the connection it describes (got {stats:#})"
    );
    assert!(
        stats["subscribed"].is_null(),
        "this connection has sent no subscribe_feeds, which is the null \
         state and not the empty-set one (got {stats:#})"
    );

    let observed = *census.get(&feed.as_byte()).unwrap_or(&0) as u64;
    assert!(
        observed > 0,
        "the client must have received at least one {feed:?} frame, or the \
         equality below would hold vacuously over a table of zeros"
    );

    let conn = stats_row(&stats["connection"], feed.as_byte())
        .unwrap_or_else(|| panic!("no connection row for {feed:?} in {stats:#}"));
    assert_eq!(
        conn["frames"].as_u64().unwrap(),
        observed,
        "the router's count for {feed:?} must equal what this client actually \
         received — a send site outside the gate shows up here (got {stats:#})"
    );
    assert!(
        conn["bytes"].as_u64().unwrap() > 0,
        "frames were counted, so bytes must have been too (got {conn:#})"
    );
    assert_eq!(
        conn["dropped"].as_u64().unwrap(),
        0,
        "nothing filters yet, so nothing can have been dropped"
    );
    assert_eq!(
        conn["name"],
        feed.name().expect("a registered feed has a name"),
        "the row carries FeedId::name()'s value"
    );

    // The global table aggregates every connection this process has served,
    // so it can only ever be at or ahead of one connection's own count.
    let global = stats_row(&stats["global"], feed.as_byte())
        .unwrap_or_else(|| panic!("no global row for {feed:?} in {stats:#}"));
    assert!(
        global["frames"].as_u64().unwrap() >= observed,
        "the process-global count cannot trail one connection's (got {stats:#})"
    );

    // A retired byte carries no traffic, and an all-zero row is omitted
    // rather than sent as 256 rows of nothing.
    assert!(
        stats_row(&stats["connection"], FeedId::STATS.as_byte()).is_none(),
        "0x30 is retired and silent, so it has no row at all (got {stats:#})"
    );
    assert!(
        stats["connection"].as_array().unwrap().len() < 256,
        "the response is the feeds that moved, not the whole namespace"
    );
}

#[tokio::test]
async fn feed_stats_is_answered_rather_than_dispatched() {
    // `feed_stats` is matched ahead of the session-lifecycle interceptor, so
    // it must not fall through to `dispatch_action` as an unknown verb. The
    // proof is that a second ask still gets a well-formed answer on a socket
    // the first one left healthy.
    let repo = make_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_control_payload(serde_json::json!({ "action": "feed_stats" }))
        .await;
    let (first, _) = ws
        .await_control_type("feed_stats", WIRE_TIMEOUT)
        .await
        .expect("first feed_stats response");

    ws.send_control_payload(serde_json::json!({ "action": "feed_stats" }))
        .await;
    let (second, _) = ws
        .await_control_type("feed_stats", WIRE_TIMEOUT)
        .await
        .expect("second feed_stats response");

    assert_eq!(first["client_id"], second["client_id"]);

    // The gate counts its own CONTROL replies, so the second answer must
    // have seen strictly more CONTROL traffic than the first reported.
    let control = FeedId::CONTROL.as_byte();
    let before = stats_row(&first["connection"], control)
        .and_then(|r| r["frames"].as_u64())
        .unwrap_or(0);
    let after = stats_row(&second["connection"], control)
        .and_then(|r| r["frames"].as_u64())
        .unwrap_or(0);
    assert!(
        after > before,
        "the first reply is itself a counted CONTROL frame, so the second \
         reading must have advanced (before={before}, after={after})"
    );
}

/// The window two clients are compared over, and the settling period a
/// subscribed client is given to *not* receive something.
const SETTLE: Duration = Duration::from_millis(1500);

/// How long the wire must be silent before a server counts as settled, and how
/// long that silence is waited for.
const QUIET: Duration = Duration::from_millis(300);
const QUIET_BUDGET: Duration = Duration::from_secs(10);

#[tokio::test]
async fn two_silent_clients_receive_the_same_thing() {
    // The wire-compatibility proof. Neither client sends subscribe_feeds, so
    // both are in the None state, and None means everything: what arrives must
    // be what arrived before this filter existed.
    let repo = make_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;

    // A scout connects first and waits for the server to settle. Not every
    // plane replays for a late joiner — the terminal plane is a live
    // broadcast, and tugcast puts a frame on it as the first client arrives —
    // so two clients connected into a *waking* server are not comparable
    // however tightly they are connected: the first sees that frame and the
    // second cannot. The scout absorbs the waking, and stays connected, since
    // dropping it would be one more event for the pair to race.
    let mut scout = TestWs::connect(tc.port).await;
    assert!(
        scout.quiesce(QUIET, QUIET_BUDGET).await,
        "the server never went quiet, so nothing after this compares two \
         clients rather than two arrival times"
    );

    // Connected together rather than one after the other, so there is no
    // ordered gap for an ambient frame to fall into.
    let (mut a, mut b) = tokio::join!(TestWs::connect(tc.port), TestWs::connect(tc.port));

    // One window covering both, rather than two windows in a row: the feeds
    // are broadcasts, and back-to-back windows would ask the two clients
    // about two different stretches of server time.
    let (census_a, census_b) = tokio::join!(a.census_over(SETTLE), b.census_over(SETTLE));

    // Compared over the gated planes only. `CONTROL` and `HEARTBEAT` are
    // exempt from the subscription filter by construction, so they are not
    // what this proves, and a heartbeat is on its own clock rather than on
    // the window's — counting it would put a periodic timer on the knife
    // edge of the census deadline. What must match is what the filter would
    // have touched.
    let gated = |census: &HashMap<u8, usize>| -> HashMap<u8, usize> {
        census
            .iter()
            .filter(|(id, _)| {
                **id != FeedId::CONTROL.as_byte() && **id != FeedId::HEARTBEAT.as_byte()
            })
            .map(|(id, n)| (*id, *n))
            .collect()
    };
    let (gated_a, gated_b) = (gated(&census_a), gated(&census_b));

    assert!(
        !gated_a.is_empty(),
        "a silent client must receive real feed traffic, not just the exempt \
         planes — equality below would hold vacuously if the default were an \
         empty subscription rather than None (got {census_a:?})"
    );
    assert_eq!(
        gated_a, gated_b,
        "two clients that said nothing must receive the same feed-id multiset"
    );
}

#[tokio::test]
async fn a_subscription_filters_the_wire_and_counts_what_it_refused() {
    // One client names a single feed; the other says nothing. Both then
    // provoke the same server-to-client frame on a feed outside that set —
    // a CODE_INPUT rejection, which the router answers on the *input feed's*
    // own id rather than on CONTROL, so it follows that feed's subscription.
    let repo = make_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;

    let mut subscribed = TestWs::connect(tc.port).await;
    let mut silent = TestWs::connect(tc.port).await;

    // JOTS only — CODE_INPUT is deliberately outside the set.
    subscribed
        .send_control_payload(serde_json::json!({
            "action": "subscribe_feeds",
            "feeds": [FeedId::JOTS.as_byte()],
        }))
        .await;

    // A CODE_INPUT frame carrying no tug_session_id is a hard reject, and the
    // rejection comes back on CODE_INPUT (0x41).
    let orphan = serde_json::json!({ "type": "user_message", "text": "hello" });
    subscribed
        .send_feed_payload(FeedId::CODE_INPUT, orphan.clone())
        .await;
    silent.send_feed_payload(FeedId::CODE_INPUT, orphan).await;

    // The silent client sees the rejection: this is the control, and it is
    // what proves the provocation actually produced a frame.
    silent
        .await_control_reject(&["missing_tug_session_id"], WIRE_TIMEOUT)
        .await
        .expect("the unfiltered client receives the CODE_INPUT rejection");

    // The subscribed client does not. Give it the same wall clock the silent
    // client needed, so this is an absence rather than a race.
    let census = subscribed.census_over(SETTLE).await;
    assert_eq!(
        census.get(&FeedId::CODE_INPUT.as_byte()),
        None,
        "a feed outside the subscription must not reach the socket at all"
    );

    // ...and the exempt planes are unaffected. HEARTBEAT is asserted here
    // rather than left to the unit test because the router's interval fires
    // its first tick immediately, so it costs nothing to check for real.
    assert!(
        census.contains_key(&FeedId::HEARTBEAT.as_byte()),
        "HEARTBEAT is exempt: a client cannot unsubscribe its own liveness \
         (got {census:?})"
    );

    // The refusal is counted rather than silent, which is the whole point of
    // putting the counter on the gate before shipping the knob. CONTROL is
    // exempt too, which is what lets this answer come back at all.
    subscribed
        .send_control_payload(serde_json::json!({ "action": "feed_stats" }))
        .await;
    let (stats, _) = subscribed
        .await_control_type("feed_stats", WIRE_TIMEOUT)
        .await
        .expect("CONTROL is exempt, so feed_stats still answers");

    assert_eq!(
        stats["subscribed"],
        serde_json::json!([FeedId::JOTS.as_byte()]),
        "the response reports the set the connection actually holds"
    );

    let row = stats_row(&stats["connection"], FeedId::CODE_INPUT.as_byte())
        .unwrap_or_else(|| panic!("no CODE_INPUT row in {stats:#}"));
    assert!(
        row["dropped"].as_u64().unwrap() >= 1,
        "the refused frame lands in the drop column (got {row:#})"
    );
    assert_eq!(
        row["frames"].as_u64().unwrap(),
        0,
        "a drop is counted instead of a send, never as well as one"
    );
    assert_eq!(
        row["bytes"].as_u64().unwrap(),
        0,
        "a refused frame is never encoded, so it can weigh nothing"
    );
}

#[tokio::test]
async fn a_malformed_subscribe_feeds_leaves_the_subscription_alone() {
    // Resetting on a malformed message would be a silent way to lose a
    // filter, so the router keeps what it had.
    let repo = make_repo();
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let mut ws = TestWs::connect(tc.port).await;

    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::JOTS.as_byte()],
    }))
    .await;
    ws.send_control_payload(serde_json::json!({ "action": "subscribe_feeds" }))
        .await;
    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": "not an array",
    }))
    .await;

    ws.send_control_payload(serde_json::json!({ "action": "feed_stats" }))
        .await;
    let (stats, _) = ws
        .await_control_type("feed_stats", WIRE_TIMEOUT)
        .await
        .expect("feed_stats response");

    assert_eq!(
        stats["subscribed"],
        serde_json::json!([FeedId::JOTS.as_byte()]),
        "two malformed messages later, the connection still holds the set it \
         was given — neither reset it to null nor emptied it (got {stats:#})"
    );
}

/// How many frames this client has seen on `feed` so far.
fn count(census: &HashMap<u8, usize>, feed: FeedId) -> usize {
    *census.get(&feed.as_byte()).unwrap_or(&0)
}

/// Spawn a tugcast over a throwaway repo and connect one client to it.
async fn one_client(repo: &TempDir) -> (TestTugcast, TestWs) {
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let tc = TestTugcast::spawn(repo.path(), bank_path).await;
    let ws = TestWs::connect(tc.port).await;
    (tc, ws)
}

#[tokio::test]
async fn a_late_subscription_re_delivers_the_retained_value() {
    // The deck's own replay cache cannot cover this: it is filled from frames
    // that arrive, and under a subscription the frame never arrived. So the
    // server has to re-deliver, and that is what needs a feed-id key on the
    // retained watch.
    let repo = make_repo();
    let (_tc, mut ws) = one_client(&repo).await;

    // Let the connect-time snapshot delivery land, so what follows is
    // measured as a delta rather than against nothing.
    let before = ws.census_over(SETTLE).await;
    assert!(
        count(&before, FeedId::JOTS) >= 1,
        "the connect-time pass must have delivered JOTS, or there is no \
         retained value to re-deliver later (got {before:?})"
    );

    // A first subscription that excludes JOTS. The previous state was None —
    // "everything" — so this adds nothing and must re-deliver nothing.
    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte()],
    }))
    .await;
    let excluded = ws.census_over(SETTLE).await;
    assert_eq!(
        count(&excluded, FeedId::JOTS),
        count(&before, FeedId::JOTS),
        "a first subscribe_feeds adds nothing by the add-set measure, so \
         nothing is re-delivered — least of all a feed it excluded"
    );

    // Now add JOTS. It is newly added against the previous set, it has a
    // retained watch, and its payload is non-empty, so its latest value
    // arrives.
    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte(), FeedId::JOTS.as_byte()],
    }))
    .await;
    let added = ws.census_over(SETTLE).await;
    assert_eq!(
        count(&added, FeedId::JOTS),
        count(&excluded, FeedId::JOTS) + 1,
        "adding a snapshot feed re-delivers exactly its retained latest value \
         (got {added:?} against {excluded:?})"
    );
}

#[tokio::test]
async fn re_subscribing_an_already_subscribed_feed_re_delivers_nothing() {
    // The add-set is a difference, not the whole set. Sending the same
    // subscription twice must be idempotent on the wire, or every reconnect
    // handshake would duplicate every snapshot the client already holds.
    let repo = make_repo();
    let (_tc, mut ws) = one_client(&repo).await;

    ws.census_over(SETTLE).await;

    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte()],
    }))
    .await;
    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte(), FeedId::JOTS.as_byte()],
    }))
    .await;
    let once = ws.census_over(SETTLE).await;
    let delivered = count(&once, FeedId::JOTS);

    // The identical set again: nothing is newly added.
    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte(), FeedId::JOTS.as_byte()],
    }))
    .await;
    let twice = ws.census_over(SETTLE).await;

    assert_eq!(
        count(&twice, FeedId::JOTS),
        delivered,
        "the same set twice delivers the retained value exactly once \
         (got {twice:?} against {once:?})"
    );
}

#[tokio::test]
async fn adding_a_stream_feed_delivers_nothing_on_its_own() {
    // A broadcast has no retained latest value, and inventing one here would
    // give stream feeds a deliver-on-subscribe pass they have never had on
    // connect either. Silence is the correct answer until a producer emits.
    let repo = make_repo();
    let (_tc, mut ws) = one_client(&repo).await;

    ws.census_over(SETTLE).await;

    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte()],
    }))
    .await;
    let before = ws.census_over(SETTLE).await;

    ws.send_control_payload(serde_json::json!({
        "action": "subscribe_feeds",
        "feeds": [FeedId::DEFAULTS.as_byte(), FeedId::CODE_OUTPUT.as_byte()],
    }))
    .await;
    let after = ws.census_over(SETTLE).await;

    assert_eq!(
        count(&after, FeedId::CODE_OUTPUT),
        count(&before, FeedId::CODE_OUTPUT),
        "a stream feed newly added to a subscription delivers nothing until \
         its producer emits (got {after:?} against {before:?})"
    );
}
