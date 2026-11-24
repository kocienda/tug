//! A session's activity tape: the last [`WINDOW_BINS`] bins of every rate
//! channel, and each gauge's current level.
//!
//! tugcast holds one tape per session, in memory only. Every producer of a
//! session's activity records into it, and the tape is what a page is sent:
//! a bin as it closes, and the whole window when the page starts listening.
//! So every surface showing one session draws the same recent past, and a
//! page that wakes mid-turn draws what really happened rather than a flat
//! line. A tugcast restart starts every tape empty, which is correct for an
//! instrument reading.
//!
//! A bin is addressed by its **index**: tugcast's clock in milliseconds since
//! the epoch divided by [`BIN_MS`]. The index travels with every frame, so a
//! frame delayed in transit is still filed in the bin it describes.
//!
//! [`SessionTape`] is a pure structure: it is told the bin index rather than
//! reading a clock, so everything it does is testable over data.
//! [`ActivityTapes`] holds one per session behind a lock, and
//! [`run_tape_publisher`] is the one clock: at each bin edge it closes the
//! bin just ended on every tape and publishes it, one frame per session that
//! did work in it. No producer publishes a rate channel itself.
//!
//! Channels are named by their wire keys, the keys the ACTIVITY feed's
//! `channels` object already carries, so a producer's payload records into
//! the tape key for key. Rate channels sum into the bin they fall in; gauges
//! are levels that publish on change and hold, and the tape keeps only each
//! one's current level.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use parking_lot::{Mutex, MutexGuard};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::feeds::session_scoped::SessionScopedFeed;

/// Width of one bin, in ms: the 4 Hz grain tugcode flushes at and the deck's
/// meters bin by.
pub const BIN_MS: u64 = 250;

/// Bins kept per rate channel: 20 seconds, the span the deck's meters hold.
pub const WINDOW_BINS: usize = 80;

/// The rate channels' wire keys. Work in a bin sums; an untouched bin is zero.
pub const RATE_CHANNELS: [&str; 5] = ["text", "tokens", "tools", "subagents", "machine"];

/// The gauge channels' wire keys. A gauge is a level, held until it moves.
pub const GAUGE_CHANNELS: [&str; 4] = ["cpu_pct", "rss_bytes", "disk_read_bps", "disk_write_bps"];

/// The bin index of a moment on tugcast's clock.
pub fn bin_index_at(at: SystemTime) -> u64 {
    let ms = at.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    (ms / u128::from(BIN_MS)) as u64
}

/// What a channel key is, or `None` for a key the tape does not carry.
fn rate_slot(channel: &str) -> Option<usize> {
    RATE_CHANNELS.iter().position(|c| *c == channel)
}

fn gauge_key(channel: &str) -> Option<&'static str> {
    GAUGE_CHANNELS.iter().copied().find(|c| *c == channel)
}

/// One closed bin: its index and the rate channels that did work in it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bin {
    pub index: u64,
    pub channels: BTreeMap<&'static str, f64>,
}

/// The tape as a page that starts listening is sent it: every rate channel's
/// bins oldest to newest, ending at the newest bin already published, and
/// each gauge's current level. Ending there is what lets the window and the
/// bin frames that follow it meet without covering a bin twice: everything
/// after `through` reaches the page as a bin frame.
///
/// A rate channel with nothing in the window is absent rather than a row of
/// zeros; the reader treats an absent channel as zero.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Window {
    /// The index of `rates[_][0]`.
    pub base: u64,
    /// The index of the newest bin, `base + WINDOW_BINS - 1`, or `None` when
    /// the tape has published no bin yet and the window holds no rates.
    pub through: Option<u64>,
    pub rates: BTreeMap<&'static str, Vec<f64>>,
    pub gauges: BTreeMap<&'static str, f64>,
}

/// One session's tape.
#[derive(Debug, Clone)]
pub struct SessionTape {
    /// The newest bin index the tape has been advanced to; `None` until the
    /// first record or advance.
    head: Option<u64>,
    /// Ring of bins per rate channel, indexed by `bin % WINDOW_BINS`.
    rates: [[f64; WINDOW_BINS]; RATE_CHANNELS.len()],
    gauges: BTreeMap<&'static str, f64>,
    /// The newest bin any rate channel did work in.
    last_work: Option<u64>,
    /// The newest bin [`SessionTape::close`] has handed out, so a bin is
    /// published once however the ticks fall.
    closed_through: Option<u64>,
}

impl Default for SessionTape {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionTape {
    pub fn new() -> Self {
        Self {
            head: None,
            rates: [[0.0; WINDOW_BINS]; RATE_CHANNELS.len()],
            gauges: BTreeMap::new(),
            last_work: None,
            closed_through: None,
        }
    }

    /// The newest bin index the tape has reached.
    #[cfg(test)]
    pub fn head(&self) -> Option<u64> {
        self.head
    }

    /// Close every bin before `now_bin` that has not been closed yet, and
    /// hand out the ones that hold work, oldest first. The tape advances to
    /// `now_bin`, so the bin in progress stays open. A bin is closed once:
    /// work filed into a bin after it closed stays on the tape for the
    /// window but is not published again.
    pub fn close(&mut self, now_bin: u64) -> Vec<Bin> {
        self.advance(now_bin);
        let Some(last) = now_bin.checked_sub(1) else {
            return Vec::new();
        };
        let oldest_in_window = now_bin.saturating_sub(WINDOW_BINS as u64 - 1);
        let from = match self.closed_through {
            Some(c) if c >= last => return Vec::new(),
            Some(c) => (c + 1).max(oldest_in_window),
            None => self.last_work.map_or(last, |w| w.min(last)).max(oldest_in_window),
        };
        self.closed_through = Some(last);
        (from..=last).filter_map(|b| self.bin(b)).collect()
    }

    /// Whether the tape can be let go as of `bin`: its work has aged out of
    /// the window and no gauge holds a level. A session's tugcode ending is
    /// what brings its gauges to zero (the sampler records a departed
    /// session's final zeros), so a live session, however idle, keeps its
    /// tape and its levels.
    pub fn droppable(&self, bin: u64) -> bool {
        self.aged_out(bin) && self.gauges.values().all(|v| *v == 0.0)
    }

    /// Record one channel's value against bin `bin`.
    ///
    /// A rate sums into its bin, advancing the tape first when the bin is
    /// newer than the head. A bin older than the head but still in the window
    /// is filed where it belongs, which is what a delayed frame needs; one
    /// older than the window lands nowhere. A non-positive or non-finite rate
    /// is nothing to record.
    ///
    /// A gauge sets the current level, whatever its bin. A key the tape does
    /// not carry is ignored.
    pub fn record(&mut self, channel: &str, value: f64, bin: u64) {
        if !value.is_finite() {
            return;
        }
        if let Some(key) = gauge_key(channel) {
            self.gauges.insert(key, value);
            return;
        }
        let Some(slot) = rate_slot(channel) else {
            return;
        };
        if value <= 0.0 {
            return;
        }
        self.advance(bin);
        let head = self.head.unwrap_or(bin);
        if head - bin >= WINDOW_BINS as u64 {
            return;
        }
        self.rates[slot][ring(bin)] += value;
        self.last_work = Some(self.last_work.map_or(bin, |w| w.max(bin)));
    }

    /// Record every channel of an ACTIVITY `channels` object against `bin`.
    /// Keys the tape does not carry, and values that are not numbers, are
    /// skipped.
    pub fn record_channels(
        &mut self,
        channels: &serde_json::Map<String, serde_json::Value>,
        bin: u64,
    ) {
        for (key, value) in channels {
            if let Some(v) = value.as_f64() {
                self.record(key, v, bin);
            }
        }
    }

    /// Move the head to `bin`, zeroing every bin it crosses. A bin at or
    /// behind the head moves nothing; the tape never runs backwards.
    pub fn advance(&mut self, bin: u64) {
        let Some(head) = self.head else {
            self.head = Some(bin);
            return;
        };
        if bin <= head {
            return;
        }
        let gap = bin - head;
        if gap >= WINDOW_BINS as u64 {
            for row in &mut self.rates {
                row.fill(0.0);
            }
        } else {
            for k in 1..=gap {
                let at = ring(head + k);
                for row in &mut self.rates {
                    row[at] = 0.0;
                }
            }
        }
        self.head = Some(bin);
    }

    /// The rate channels that did work in `bin`, or `None` when the bin is
    /// empty, ahead of the head, or out of the window.
    pub fn bin(&self, bin: u64) -> Option<Bin> {
        let head = self.head?;
        if bin > head || head - bin >= WINDOW_BINS as u64 {
            return None;
        }
        let at = ring(bin);
        let channels: BTreeMap<&'static str, f64> = RATE_CHANNELS
            .iter()
            .zip(self.rates.iter())
            .filter(|(_, row)| row[at] > 0.0)
            .map(|(key, row)| (*key, row[at]))
            .collect();
        (!channels.is_empty()).then_some(Bin { index: bin, channels })
    }

    /// The window a page that starts listening is sent: the [`WINDOW_BINS`]
    /// bins ending at the newest one [`SessionTape::close`] has handed out,
    /// every rate channel that holds work in them, and the gauges' current
    /// levels. A tape that has closed no bin yet sends its gauges alone; its
    /// work reaches the page as bin frames when the bins close.
    pub fn window(&self) -> Window {
        let gauges = self.gauges.clone();
        let (Some(through), Some(head)) = (self.closed_through, self.head) else {
            return Window { base: 0, through: None, rates: BTreeMap::new(), gauges };
        };
        let base = through.saturating_sub(WINDOW_BINS as u64 - 1);
        let mut rates = BTreeMap::new();
        for (key, row) in RATE_CHANNELS.iter().zip(self.rates.iter()) {
            let bins: Vec<f64> = (base..=through)
                .map(|b| {
                    // A slot the head has lapped holds a newer bin's work.
                    if b > head || head - b >= WINDOW_BINS as u64 { 0.0 } else { row[ring(b)] }
                })
                .collect();
            if bins.iter().any(|v| *v > 0.0) {
                rates.insert(*key, bins);
            }
        }
        Window { base, through: Some(through), rates, gauges }
    }

    /// The sum of a rate channel over every bin the tape holds, published or
    /// not.
    #[cfg(test)]
    fn held(&self, channel: &str) -> f64 {
        let (Some(slot), Some(head)) = (rate_slot(channel), self.head) else {
            return 0.0;
        };
        (head.saturating_sub(WINDOW_BINS as u64 - 1)..=head)
            .map(|b| self.rates[slot][ring(b)])
            .sum()
    }

    /// Whether every bin of work has aged out of the window as of `bin`:
    /// nothing a page could be sent would draw a rate. Gauges do not count,
    /// since they hold.
    pub fn aged_out(&self, bin: u64) -> bool {
        match self.last_work {
            None => true,
            Some(w) => bin.saturating_sub(w) >= WINDOW_BINS as u64,
        }
    }
}

fn ring(bin: u64) -> usize {
    (bin % WINDOW_BINS as u64) as usize
}

/// Every session's tape, shared by the producers that record into them and
/// the publisher that closes their bins. The lock is held only for a record
/// or a tick, never across an await.
#[derive(Clone, Default)]
pub struct ActivityTapes {
    inner: Arc<Mutex<HashMap<String, SessionTape>>>,
    /// Rung when a record makes a tape, so a publisher parked over no tapes
    /// starts its clock again. A permit is kept when nothing is parked, so a
    /// record between the publisher's look and its wait is not lost.
    made: Arc<Notify>,
}

impl ActivityTapes {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, SessionTape>> {
        self.inner.lock()
    }

    /// Record an ACTIVITY `channels` object for `session` in the bin `at`
    /// falls in.
    pub fn record_channels(
        &self,
        session: &str,
        channels: &serde_json::Map<String, serde_json::Value>,
        at: SystemTime,
    ) {
        let bin = bin_index_at(at);
        let mut tapes = self.lock();
        let made = !tapes.contains_key(session);
        tapes.entry(session.to_owned()).or_default().record_channels(channels, bin);
        drop(tapes);
        if made {
            self.made.notify_one();
        }
    }

    /// Record a frame that carries its own `tug_session_id` and `channels`,
    /// as tugcode's spliced `activity_delta` does. A payload missing either
    /// records nothing.
    pub fn record_payload(&self, payload: &[u8], at: SystemTime) {
        let Ok(serde_json::Value::Object(frame)) = serde_json::from_slice(payload) else {
            return;
        };
        let (Some(session), Some(serde_json::Value::Object(channels))) = (
            frame.get("tug_session_id").and_then(|v| v.as_str()),
            frame.get("channels"),
        ) else {
            return;
        };
        self.record_channels(session, channels, at);
    }

    /// Close the bins before `now_bin` on every tape and hand out the ones
    /// with work, then let go of the tapes [`SessionTape::droppable`] says
    /// nothing is left on.
    pub fn tick(&self, now_bin: u64) -> Vec<(String, Bin)> {
        let mut tapes = self.lock();
        let mut out = Vec::new();
        for (session, tape) in tapes.iter_mut() {
            out.extend(tape.close(now_bin).into_iter().map(|b| (session.clone(), b)));
        }
        tapes.retain(|_, tape| !tape.droppable(now_bin));
        out
    }

    /// The sessions that hold a tape.
    pub fn sessions(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// Whether no session holds a tape: nothing to close and nothing a page
    /// could be sent.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Resolves once a record has made a tape since the last time it
    /// resolved.
    pub async fn tape_made(&self) {
        self.made.notified().await;
    }

    /// `session`'s window, or `None` when it holds no tape.
    pub fn window(&self, session: &str) -> Option<Window> {
        self.lock().get(session).map(SessionTape::window)
    }

    /// The sum of a rate channel over every bin `session`'s tape holds, or
    /// `None` when there is no tape for it.
    #[cfg(test)]
    pub fn window_total(&self, session: &str, channel: &str) -> Option<f64> {
        Some(self.lock().get(session)?.held(channel))
    }

    /// A gauge's current level on `session`'s tape.
    #[cfg(test)]
    pub fn gauge(&self, session: &str, channel: &str) -> Option<f64> {
        self.lock().get(session)?.gauges.get(channel).copied()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// The ACTIVITY payload for one closed bin, before the session splice: its
/// index and the rate channels that did work in it.
pub fn bin_payload(bin: &Bin) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "type": "activity_bin",
        "bin": bin.index,
        "channels": bin.channels,
    }))
    .expect("a json object of plain values serializes")
}

/// The ACTIVITY payload a page that starts listening is sent for one
/// session, before the session splice. It rides the one ACTIVITY feed,
/// told apart from a bin frame by its `type`.
pub fn window_payload(window: &Window) -> Vec<u8> {
    let mut body = serde_json::Map::new();
    body.insert("type".into(), serde_json::json!("activity_window"));
    if let serde_json::Value::Object(fields) =
        serde_json::to_value(window).expect("a window of plain values serializes")
    {
        body.extend(fields);
    }
    serde_json::to_vec(&body).expect("a json object of plain values serializes")
}

/// How far past a bin edge the publisher wakes, so a wake that lands a hair
/// early still reads the new bin.
const EDGE_SLACK_MS: u64 = 5;

/// The tapes' one clock: wake at each bin edge, close the bin just ended on
/// every tape, and publish each session's bin that held work. A bin with
/// nothing in it is not published; the deck reads silence as zero.
///
/// The clock runs only while some session holds a tape. With none — no
/// session in a turn and no work left in any window — it parks until a
/// record makes one, so an idle tugcast does no work at all.
pub async fn run_tape_publisher(
    tapes: ActivityTapes,
    activity: SessionScopedFeed,
    cancel: CancellationToken,
) {
    loop {
        if tapes.is_empty() {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tapes.tape_made() => {}
            }
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let wait = BIN_MS - now_ms % BIN_MS + EDGE_SLACK_MS;
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_millis(wait)) => {}
        }
        for (session, bin) in tapes.tick(bin_index_at(SystemTime::now())) {
            activity.publish(&session, &bin_payload(&bin));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const T0: u64 = 1_000_000;

    #[test]
    fn the_bin_index_is_the_clock_over_the_bin_width() {
        let at = UNIX_EPOCH + Duration::from_millis(10_249);
        assert_eq!(bin_index_at(at), 40);
        assert_eq!(bin_index_at(UNIX_EPOCH + Duration::from_millis(10_250)), 41);
    }

    #[test]
    fn work_in_one_bin_sums() {
        let mut tape = SessionTape::new();
        tape.record("text", 30.0, T0);
        tape.record("text", 12.0, T0);
        tape.record("tools", 1.0, T0);
        let bin = tape.bin(T0).expect("the bin holds work");
        assert_eq!(bin.channels.get("text"), Some(&42.0));
        assert_eq!(bin.channels.get("tools"), Some(&1.0));
        assert_eq!(bin.channels.get("tokens"), None);
    }

    #[test]
    fn advancing_zeroes_the_bins_it_crosses_and_keeps_the_rest() {
        let mut tape = SessionTape::new();
        tape.record("text", 5.0, T0);
        tape.advance(T0 + 3);
        assert_eq!(tape.head(), Some(T0 + 3));
        assert_eq!(tape.bin(T0).map(|b| b.channels["text"]), Some(5.0));
        for b in T0 + 1..=T0 + 3 {
            assert_eq!(tape.bin(b), None, "bin {b} was crossed and is empty");
        }
        // A full lap later the slot the old bin used is reused and clean.
        tape.advance(T0 + WINDOW_BINS as u64);
        assert_eq!(tape.bin(T0), None, "out of the window");
        assert_eq!(tape.bin(T0 + WINDOW_BINS as u64), None);
    }

    #[test]
    fn a_jump_past_the_window_clears_it() {
        let mut tape = SessionTape::new();
        tape.record("tokens", 9.0, T0);
        tape.close(T0 + 500);
        assert!(tape.window().rates.is_empty());
    }

    #[test]
    fn the_tape_never_runs_backwards() {
        let mut tape = SessionTape::new();
        tape.advance(T0 + 10);
        tape.advance(T0);
        assert_eq!(tape.head(), Some(T0 + 10));
    }

    #[test]
    fn a_late_frame_is_filed_in_the_bin_it_describes() {
        let mut tape = SessionTape::new();
        tape.advance(T0 + 4);
        tape.record("text", 7.0, T0 + 1);
        assert_eq!(tape.head(), Some(T0 + 4), "a late frame does not move the head");
        assert_eq!(tape.bin(T0 + 1).map(|b| b.channels["text"]), Some(7.0));
        assert_eq!(tape.bin(T0 + 4), None);
    }

    #[test]
    fn a_frame_older_than_the_window_lands_nowhere() {
        let mut tape = SessionTape::new();
        tape.advance(T0 + WINDOW_BINS as u64);
        tape.record("text", 7.0, T0);
        tape.close(T0 + WINDOW_BINS as u64 + 1);
        assert!(tape.window().rates.is_empty());
        assert!(tape.aged_out(T0 + WINDOW_BINS as u64));
    }

    #[test]
    fn nothing_and_unknown_keys_are_not_recorded() {
        let mut tape = SessionTape::new();
        tape.record("text", 0.0, T0);
        tape.record("text", -3.0, T0);
        tape.record("text", f64::NAN, T0);
        tape.record("cpu", 50.0, T0);
        tape.record("weather", 1.0, T0);
        assert!(tape.window().rates.is_empty());
        assert!(tape.window().gauges.is_empty());
    }

    #[test]
    fn the_window_is_every_working_channel_oldest_to_newest() {
        let mut tape = SessionTape::new();
        tape.record("text", 1.0, T0);
        tape.record("text", 2.0, T0 + 2);
        tape.record("machine", 600.0, T0 + 1);
        tape.close(T0 + 3);
        let window = tape.window();
        assert_eq!(window.base, T0 + 2 - (WINDOW_BINS as u64 - 1));
        assert_eq!(window.through, Some(T0 + 2));
        let text = &window.rates["text"];
        assert_eq!(text.len(), WINDOW_BINS);
        assert_eq!(text[WINDOW_BINS - 1], 2.0, "the newest bin is last");
        assert_eq!(text[WINDOW_BINS - 2], 0.0);
        assert_eq!(text[WINDOW_BINS - 3], 1.0);
        assert_eq!(window.rates["machine"][WINDOW_BINS - 2], 600.0);
        assert!(!window.rates.contains_key("tokens"), "an idle channel is absent");
    }

    #[test]
    fn an_empty_tape_has_an_empty_window() {
        let window = SessionTape::new().window();
        assert_eq!(window.through, None);
        assert!(window.rates.is_empty());
        assert!(window.gauges.is_empty());
    }

    #[test]
    fn gauges_keep_their_current_level_whatever_the_bin() {
        let mut tape = SessionTape::new();
        tape.record("cpu_pct", 40.0, T0);
        tape.record("rss_bytes", 1024.0, T0);
        tape.advance(T0 + 1_000);
        tape.record("cpu_pct", 12.5, T0 + 3);
        tape.record("cpu_pct", 0.0, T0 + 1_000);
        let window = tape.window();
        assert_eq!(window.gauges.get("cpu_pct"), Some(&0.0), "a zero is a level");
        assert_eq!(window.gauges.get("rss_bytes"), Some(&1024.0), "held across the jump");
        assert!(tape.aged_out(T0 + 1_000), "gauges do not keep a tape alive");
    }

    #[test]
    fn an_activity_payload_records_key_for_key() {
        let mut tape = SessionTape::new();
        let channels = serde_json::json!({
            "text": 10, "tools": 2, "cpu_pct": 33.0, "unknown": 5, "tokens": "lots"
        });
        tape.record_channels(channels.as_object().expect("an object"), T0);
        let bin = tape.bin(T0).expect("the bin holds work");
        assert_eq!(bin.channels.len(), 2);
        assert_eq!(bin.channels["text"], 10.0);
        assert_eq!(tape.window().gauges.get("cpu_pct"), Some(&33.0));
    }

    #[test]
    fn a_tape_ages_out_a_window_after_its_last_work() {
        let mut tape = SessionTape::new();
        assert!(tape.aged_out(T0), "a tape that never worked has nothing to keep");
        tape.record("subagents", 1.0, T0);
        assert!(!tape.aged_out(T0 + WINDOW_BINS as u64 - 1));
        assert!(tape.aged_out(T0 + WINDOW_BINS as u64));
    }

    #[test]
    fn the_window_serializes_with_its_base_and_its_newest_bin() {
        let mut tape = SessionTape::new();
        tape.record("text", 4.0, T0);
        tape.record("cpu_pct", 7.5, T0);
        tape.close(T0 + 1);
        let json = serde_json::to_value(tape.window()).expect("serializes");
        assert_eq!(json["base"], serde_json::json!(T0 - (WINDOW_BINS as u64 - 1)));
        assert_eq!(json["through"], serde_json::json!(T0));
        assert_eq!(json["rates"]["text"].as_array().map(Vec::len), Some(WINDOW_BINS));
        assert_eq!(json["gauges"]["cpu_pct"], serde_json::json!(7.5));
    }

    #[test]
    fn the_window_ends_at_the_newest_published_bin() {
        let mut tape = SessionTape::new();
        tape.record("text", 1.0, T0);
        tape.close(T0 + 1);
        // Work in the open bin, and in a bin the publisher has not closed
        // yet, reaches the page as bin frames, not in the window.
        tape.record("text", 5.0, T0 + 1);
        tape.record("text", 9.0, T0 + 2);
        let window = tape.window();
        assert_eq!(window.through, Some(T0));
        assert_eq!(window.rates["text"].iter().sum::<f64>(), 1.0);
    }

    #[test]
    fn a_tape_that_published_nothing_sends_its_gauges_alone() {
        let mut tape = SessionTape::new();
        tape.record("text", 3.0, T0);
        tape.record("rss_bytes", 2048.0, T0);
        let window = tape.window();
        assert_eq!(window.through, None);
        assert!(window.rates.is_empty(), "its bin is published when it closes");
        assert_eq!(window.gauges.get("rss_bytes"), Some(&2048.0));
    }

    #[test]
    fn the_window_reads_nothing_from_a_slot_the_head_has_lapped() {
        let mut tape = SessionTape::new();
        tape.record("text", 2.0, T0);
        tape.close(T0 + 1);
        // The head moves on without a close, onto the slot bin T0 used.
        tape.record("tools", 4.0, T0 + WINDOW_BINS as u64);
        let window = tape.window();
        assert_eq!(window.through, Some(T0));
        assert!(!window.rates.contains_key("tools"), "a newer bin's work is not the window's");
        assert!(!window.rates.contains_key("text"), "bin T0 has left the tape");
    }

    #[test]
    fn a_window_frame_carries_every_part_of_the_window() {
        let mut tape = SessionTape::new();
        tape.record("text", 4.0, T0);
        tape.record("cpu_pct", 1.5, T0);
        tape.close(T0 + 1);
        let json: serde_json::Value =
            serde_json::from_slice(&window_payload(&tape.window())).expect("parses");
        assert_eq!(json["type"], "activity_window");
        assert_eq!(json["through"], serde_json::json!(T0));
        assert_eq!(json["base"], serde_json::json!(T0 - (WINDOW_BINS as u64 - 1)));
        assert_eq!(json["rates"]["text"][WINDOW_BINS - 1], serde_json::json!(4.0));
        assert_eq!(json["gauges"]["cpu_pct"], serde_json::json!(1.5));
    }

    #[test]
    fn tapes_answer_for_their_sessions_windows() {
        let tapes = ActivityTapes::default();
        let at = UNIX_EPOCH + Duration::from_millis(T0 * BIN_MS);
        let channels = serde_json::json!({"text": 2});
        tapes.record_channels("a", channels.as_object().expect("an object"), at);
        tapes.tick(T0 + 1);
        assert_eq!(tapes.sessions(), vec!["a".to_string()]);
        let window = tapes.window("a").expect("a has a tape");
        assert_eq!(window.through, Some(T0));
        assert!(tapes.window("b").is_none());
    }

    #[test]
    fn a_bin_closes_once_the_clock_has_left_it() {
        let mut tape = SessionTape::new();
        tape.record("text", 3.0, T0);
        assert!(tape.close(T0).is_empty(), "the bin in progress stays open");
        let closed = tape.close(T0 + 1);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].index, T0);
        assert_eq!(closed[0].channels["text"], 3.0);
        assert!(tape.close(T0 + 1).is_empty(), "a bin is handed out once");
        assert!(tape.close(T0 + 2).is_empty(), "an empty bin is not handed out");
    }

    #[test]
    fn a_late_tick_closes_every_bin_it_skipped() {
        let mut tape = SessionTape::new();
        tape.record("text", 1.0, T0);
        assert!(tape.close(T0 + 1).len() == 1);
        tape.record("text", 2.0, T0 + 1);
        tape.record("tools", 1.0, T0 + 3);
        let closed: Vec<u64> = tape.close(T0 + 5).iter().map(|b| b.index).collect();
        assert_eq!(closed, vec![T0 + 1, T0 + 3]);
    }

    #[test]
    fn a_tape_is_droppable_once_its_work_aged_out_and_its_gauges_are_down() {
        let mut tape = SessionTape::new();
        tape.record("text", 1.0, T0);
        tape.record("rss_bytes", 4096.0, T0);
        let later = T0 + WINDOW_BINS as u64;
        assert!(!tape.droppable(later), "a live session's level keeps its tape");
        tape.record("rss_bytes", 0.0, later);
        assert!(tape.droppable(later), "its tugcode ended and its work aged out");
        tape.record("text", 1.0, later);
        assert!(!tape.droppable(later), "new work keeps it");
    }

    #[test]
    fn tapes_publish_each_sessions_closed_bin_and_let_go_of_the_dead() {
        let tapes = ActivityTapes::default();
        let at = UNIX_EPOCH + Duration::from_millis(T0 * BIN_MS);
        let a = serde_json::json!({"text": 5, "cpu_pct": 0.0});
        tapes.record_channels("a", a.as_object().expect("an object"), at);
        tapes.record_payload(
            br#"{"tug_session_id":"b","type":"activity_delta","channels":{"tools":2}}"#,
            at,
        );
        tapes.record_payload(br#"{"type":"activity_delta","channels":{"tools":2}}"#, at);
        let mut bins = tapes.tick(T0 + 1);
        bins.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(bins.len(), 2);
        assert_eq!((bins[0].0.as_str(), bins[0].1.channels["text"]), ("a", 5.0));
        assert_eq!((bins[1].0.as_str(), bins[1].1.channels["tools"]), ("b", 2.0));
        assert_eq!(tapes.window_total("b", "tools"), Some(2.0));
        assert_eq!(tapes.gauge("a", "cpu_pct"), Some(0.0));
        assert_eq!(tapes.len(), 2);
        assert!(tapes.tick(T0 + WINDOW_BINS as u64).is_empty());
        assert_eq!(tapes.len(), 0, "both aged out with no level held");
    }

    #[tokio::test]
    async fn a_record_that_makes_a_tape_wakes_a_parked_publisher() {
        let tapes = ActivityTapes::default();
        assert!(tapes.is_empty(), "an idle tugcast holds no tape");
        let channels = serde_json::json!({"text": 1});
        tapes.record_channels("a", channels.as_object().expect("an object"), SystemTime::now());
        assert!(!tapes.is_empty());
        // The record came before the wait; its permit is what ends it.
        tokio::time::timeout(Duration::from_secs(1), tapes.tape_made())
            .await
            .expect("the tape's making is not lost");
        // A record onto a tape that already exists makes nothing.
        tapes.record_channels("a", channels.as_object().expect("an object"), SystemTime::now());
        assert!(
            tokio::time::timeout(Duration::from_millis(50), tapes.tape_made()).await.is_err(),
            "only a new tape wakes the publisher"
        );
    }

    #[test]
    fn a_bin_frame_carries_its_index_and_its_channels() {
        let bin = Bin { index: T0, channels: [("text", 4.0)].into_iter().collect() };
        let json: serde_json::Value =
            serde_json::from_slice(&bin_payload(&bin)).expect("parses");
        assert_eq!(json["type"], "activity_bin");
        assert_eq!(json["bin"], serde_json::json!(T0));
        assert_eq!(json["channels"], serde_json::json!({"text": 4.0}));
    }
}
