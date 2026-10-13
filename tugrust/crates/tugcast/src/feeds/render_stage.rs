//! render_stage — the pure half of the `RENDERED` feed.
//!
//! The stage keeps every live session's assistant text and thinking prose
//! as the deck's reducer accumulates it, and renders what changed with
//! tugmark. Like `session_digest`, it reads no clock, does no IO and knows no
//! channel: time enters as a parameter, and `render_bridge` holds the
//! broadcast, the pacing and the hold.
//!
//! A render is three calls, so the parse never runs under anything the
//! bridge's async loop waits on:
//!
//! 1. [`RenderStage::take_dirty`] snapshots every dirty message's text into a
//!    [`RenderJob`] and clears the dirty marks, up to a tick's budget of text;
//!    what the budget leaves stays dirty, in order, for the next tick;
//! 2. [`RenderJob::render`] parses, sanitizes and transforms each snapshot,
//!    the messages in parallel, so a tick costs its slowest message rather
//!    than the sum. It owns everything it reads, so it runs on a blocking
//!    thread while the stage keeps ingesting;
//! 3. [`RenderStage::settle`] records what was emitted and returns the
//!    emission, one entry per message.
//!
//! An emission carries the message's ordered block list from the first block
//! that differs from the message's previous emission, and HTML only for
//! hashes it had not emitted before, so the deck receives each block once.
//! A resync forgets both, so its emission is whole.
//!
//! Replayed history is indexed, not rendered: inside a `replay_started` /
//! `replay_complete` bracket a message's text is still accumulated, for find,
//! but it is never marked dirty and never emitted.

use std::collections::{BTreeMap, HashMap, HashSet};

use rayon::prelude::*;
use serde::Deserialize;

use super::find_index::{Extracted, UnitText};
use super::render_bridge::{
    RenderChannel, RenderedBlockWire, RenderedMessageWire, RenderedSessionWire,
};

/// The wire's key for one Message: `wireMessageKey` in the deck's reducer.
pub fn wire_message_key(msg_id: &str, block_index: Option<u64>) -> String {
    match block_index {
        Some(index) => format!("{msg_id}-b{index}"),
        // The reducer interpolates `undefined`, so the key it mints for a
        // frame with no index is this one.
        None => format!("{msg_id}-bundefined"),
    }
}

/// The `CODE_OUTPUT` fields this stage reads.
#[derive(Deserialize)]
struct TextFrame {
    #[serde(rename = "type")]
    kind: Option<String>,
    tug_session_id: Option<String>,
    msg_id: Option<String>,
    block_index: Option<u64>,
    #[serde(default)]
    is_partial: bool,
    text: Option<String>,
}

/// One Message the stage holds.
#[derive(Debug)]
struct MessageRender {
    channel: RenderChannel,
    /// The text as the deck's reducer holds it.
    text: String,
    /// Hashes whose HTML has been emitted for this message.
    last_emitted: HashSet<u64>,
    /// The block list of the last emission, which the next is a diff from;
    /// cleared with `last_emitted`.
    last_blocks: Vec<RenderedBlockWire>,
    /// The number of the last emission.
    seq: u64,
    /// Bumped whenever `last_emitted` is cleared, so a render that was in
    /// flight across a resync cannot write back the set it cleared.
    epoch: u64,
    /// Live text has changed since the last render.
    dirty: bool,
    /// The message has been emitted at least once, so a resync re-sends it.
    /// A replayed message never has been.
    emitted: bool,
    /// The idle sweep dropped `text` and `last_emitted`.
    swept: bool,
    /// The rendered text find searches ([P13]); `None` until rendered.
    find_text: Option<String>,
    /// `text` has changed since `find_text` was extracted.
    find_stale: bool,
}

/// One session's messages.
#[derive(Debug, Default)]
struct SessionRenders {
    messages: HashMap<String, MessageRender>,
    /// The clock reading of the last frame that reached this session.
    last_activity_ms: u64,
}

/// What the stage holds for every session it has seen.
#[derive(Debug, Default)]
pub struct RenderStage {
    sessions: HashMap<String, SessionRenders>,
    /// Dirty messages as `(session, messageKey)`, in the order they turned
    /// dirty, so a frame never walks every message the stage holds.
    pending: Vec<(String, String)>,
    /// Sessions inside a replay bracket.
    muted: HashSet<String>,
}

/// One message's snapshot, as `take_dirty` took it.
#[derive(Debug)]
struct JobItem {
    session: String,
    key: String,
    channel: RenderChannel,
    text: String,
    last_emitted: HashSet<u64>,
    epoch: u64,
}

/// The text one tick renders at most, summed over its messages. A message
/// larger than the whole budget still renders, alone, so nothing waits
/// forever; the rest wait one tick each.
pub const TICK_BUDGET_BYTES: usize = 256 * 1024;

/// Everything one render reads, owned, so it can run on another thread.
#[derive(Debug, Default)]
pub struct RenderJob {
    items: Vec<JobItem>,
}

/// One rendered message, ready for `settle`.
#[derive(Debug)]
struct RenderedItem {
    session: String,
    epoch: u64,
    emitted_hashes: HashSet<u64>,
    find_text: String,
    wire: RenderedMessageWire,
}

/// What a [`RenderJob`] produced.
#[derive(Debug, Default)]
pub struct RenderOutput {
    items: Vec<RenderedItem>,
}

impl RenderJob {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Render every snapshot, the messages in parallel. Pure and owned: the
    /// parse runs here, off the bridge's loop ([P08]), and the output keeps
    /// the job's order.
    pub fn render(self) -> RenderOutput {
        let items = self
            .items
            .into_par_iter()
            .map(|item| {
                // Highlight only the blocks whose HTML this emission carries.
                let blocks = tugmark::render_blocks_with(&item.text, |hash| {
                    !item.last_emitted.contains(&hash)
                });
                let mut html = BTreeMap::new();
                for block in &blocks {
                    if !item.last_emitted.contains(&block.hash) {
                        html.entry(block.hash.to_string())
                            .or_insert_with(|| block.html.clone());
                    }
                }
                let emitted_hashes: HashSet<u64> = blocks.iter().map(|b| b.hash).collect();
                let find_text = tugmark::rendered_text(&blocks);
                RenderedItem {
                    session: item.session,
                    epoch: item.epoch,
                    emitted_hashes,
                    find_text,
                    wire: RenderedMessageWire {
                        message_key: item.key,
                        channel: item.channel,
                        // Numbered and cut to a diff by `settle`.
                        seq: 0,
                        base_seq: 0,
                        blocks_from: 0,
                        blocks: blocks.iter().map(RenderedBlockWire::from).collect(),
                        html,
                        text_length: item.text.encode_utf16().count() as u32,
                        text_hash: tugmark::text_hash(&item.text).to_string(),
                    },
                }
            })
            .collect();
        RenderOutput { items }
    }
}

impl RenderStage {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read one `CODE_OUTPUT` frame. Returns true when a message turned
    /// dirty, which is what the bridge arms its period timer on.
    pub fn ingest(&mut self, payload: &[u8], now_ms: u64) -> bool {
        let Ok(frame) = serde_json::from_slice::<TextFrame>(payload) else {
            return false;
        };
        let (Some(kind), Some(session)) = (frame.kind.as_deref(), frame.tug_session_id) else {
            return false;
        };
        let channel = match kind {
            "replay_started" => {
                self.muted.insert(session);
                return false;
            }
            "replay_complete" => {
                self.muted.remove(&session);
                return false;
            }
            "assistant_text" => RenderChannel::Text,
            "thinking_text" => RenderChannel::Thinking,
            _ => return false,
        };
        let Some(msg_id) = frame.msg_id else {
            return false;
        };
        let delta = frame.text.unwrap_or_default();
        let key = wire_message_key(&msg_id, frame.block_index);
        let muted = self.muted.contains(&session);

        let renders = self.sessions.entry(session.clone()).or_default();
        renders.last_activity_ms = now_ms;
        let message = renders
            .messages
            .entry(key.clone())
            .or_insert_with(|| MessageRender {
                channel,
                text: String::new(),
                last_emitted: HashSet::new(),
                last_blocks: Vec::new(),
                seq: 0,
                epoch: 0,
                dirty: false,
                emitted: false,
                swept: false,
                find_text: None,
                find_stale: false,
            });
        // The reducer drops a delta whose kind disagrees with the Message it
        // addresses; so does the stage, or the two would hold different text.
        if message.channel != channel {
            return false;
        }
        // `handleTextDelta`: a partial appends, a whole frame replaces.
        if frame.is_partial {
            message.text.push_str(&delta);
        } else {
            message.text = delta;
        }
        message.swept = false;
        message.find_stale = true;
        if muted {
            return false;
        }
        if !message.dirty {
            message.dirty = true;
            self.pending.push((session, key));
        }
        true
    }

    /// Whether any message waits on a render.
    pub fn is_dirty(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Snapshot dirty messages, oldest first, up to a tick's budget, and
    /// clear their marks.
    pub fn take_dirty(&mut self) -> RenderJob {
        self.take_dirty_within(TICK_BUDGET_BYTES)
    }

    /// Snapshot dirty messages, oldest first, until their text reaches
    /// `budget` bytes; the first is always taken. The rest stay dirty and
    /// pending, in their order, for the next tick.
    pub fn take_dirty_within(&mut self, budget: usize) -> RenderJob {
        let mut items = Vec::new();
        let mut spent = 0usize;
        let mut pending = std::mem::take(&mut self.pending).into_iter();
        for (session, key) in pending.by_ref() {
            let Some(renders) = self.sessions.get_mut(&session) else {
                continue;
            };
            let Some(message) = renders.messages.get_mut(&key) else {
                continue;
            };
            if !message.dirty {
                continue;
            }
            if !items.is_empty() && spent + message.text.len() > budget {
                self.pending.push((session, key));
                break;
            }
            spent += message.text.len();
            message.dirty = false;
            items.push(JobItem {
                text: message.text.clone(),
                channel: message.channel,
                last_emitted: message.last_emitted.clone(),
                epoch: message.epoch,
                session,
                key,
            });
        }
        self.pending.extend(pending);
        RenderJob { items }
    }

    /// Record what a render emitted and return its emission, grouped by
    /// session, each message's block list cut to a diff from the last one
    /// emitted. A message whose session closed while it rendered is
    /// dropped; one resynced while it rendered keeps its cleared set, so its
    /// next emission still carries all its HTML.
    pub fn settle(&mut self, output: RenderOutput) -> Vec<RenderedSessionWire> {
        let mut batch: Vec<RenderedSessionWire> = Vec::new();
        for mut item in output.items {
            let Some(renders) = self.sessions.get_mut(&item.session) else {
                continue;
            };
            let Some(message) = renders.messages.get_mut(&item.wire.message_key) else {
                continue;
            };
            if message.epoch == item.epoch {
                message.last_emitted = item.emitted_hashes;
            }
            let whole = std::mem::take(&mut item.wire.blocks);
            let from = message
                .last_blocks
                .iter()
                .zip(&whole)
                .take_while(|(was, is)| was == is)
                .count();
            item.wire.base_seq = if from == 0 { 0 } else { message.seq };
            item.wire.blocks_from = from as u32;
            item.wire.blocks = whole[from..].to_vec();
            message.last_blocks = whole;
            message.seq += 1;
            item.wire.seq = message.seq;
            message.emitted = true;
            // A delta that landed during the render leaves the find text
            // stale; the next render refreshes it.
            message.find_stale = message.dirty;
            message.find_text = Some(item.find_text);
            match batch.iter_mut().find(|s| s.tug_session_id == item.session) {
                Some(entry) => entry.messages.push(item.wire),
                None => batch.push(RenderedSessionWire {
                    tug_session_id: item.session,
                    messages: vec![item.wire],
                }),
            }
        }
        batch
    }

    /// Forget what was emitted for one message, one session's messages, or
    /// every message, and mark them dirty so their next emission carries
    /// all their HTML ([P07]). Only messages already emitted are re-sent: a
    /// replayed message was never the deck's to draw from a render. What
    /// turned dirty is rendered at the next tick, as any dirty message is.
    pub fn resync(&mut self, session: Option<&str>, message_key: Option<&str>) {
        for (id, renders) in &mut self.sessions {
            if session.is_some_and(|s| s != id) {
                continue;
            }
            for (key, message) in &mut renders.messages {
                if message_key.is_some_and(|k| k != key) {
                    continue;
                }
                if !message.emitted || message.swept {
                    continue;
                }
                message.last_emitted.clear();
                message.last_blocks.clear();
                message.epoch += 1;
                if !message.dirty {
                    message.dirty = true;
                    self.pending.push((id.clone(), key.clone()));
                }
            }
        }
    }

    /// Drop everything held for a closed session, render and find alike.
    pub fn drop_session(&mut self, session: &str) {
        self.sessions.remove(session);
        self.pending.retain(|(s, _)| s != session);
        self.muted.remove(session);
    }

    /// Drop the render state (text and emitted hashes) of every session no
    /// frame has reached for `idle_ms`. Find text is kept, because an idle
    /// session is still searchable; a message whose find text is stale keeps
    /// its source text so it can still be extracted. Returns the sessions
    /// swept.
    pub fn sweep_idle(&mut self, now_ms: u64, idle_ms: u64) -> Vec<String> {
        let mut swept = Vec::new();
        for (id, renders) in &mut self.sessions {
            if now_ms.saturating_sub(renders.last_activity_ms) < idle_ms {
                continue;
            }
            let mut any = false;
            for message in renders.messages.values_mut() {
                if message.swept || message.dirty {
                    continue;
                }
                message.last_emitted = HashSet::new();
                message.last_blocks = Vec::new();
                if !message.find_stale {
                    message.text = String::new();
                }
                message.swept = true;
                any = true;
            }
            if any {
                swept.push(id.clone());
            }
        }
        swept
    }

    /// What a find query reads for one unit: the rendered text when it is
    /// current, the source when the rendered text has to be extracted (a
    /// replayed Message, or one that changed since its last render), or
    /// nothing for a unit the stage has never seen.
    pub fn find_unit(&self, session: &str, message_key: &str) -> UnitText {
        let Some(message) = self
            .sessions
            .get(session)
            .and_then(|renders| renders.messages.get(message_key))
        else {
            return UnitText::Missing;
        };
        if !message.find_stale
            && let Some(text) = &message.find_text
        {
            return UnitText::Ready(text.clone());
        }
        if message.text.is_empty() {
            return UnitText::Ready(String::new());
        }
        UnitText::Extract {
            source: message.text.clone(),
        }
    }

    /// Keep the rendered texts a find extracted, each only while the
    /// Message's text is still the source it was extracted from.
    pub fn keep_find_texts(&mut self, session: &str, extracted: Vec<Extracted>) {
        let Some(renders) = self.sessions.get_mut(session) else {
            return;
        };
        for entry in extracted {
            let Some(message) = renders.messages.get_mut(&entry.unit) else {
                continue;
            };
            if tugmark::text_hash(&message.text) != entry.source_hash {
                continue;
            }
            message.find_text = Some(entry.text);
            message.find_stale = false;
        }
    }

    /// The find text held for a message, when it is current.
    #[cfg(test)]
    pub fn find_text(&self, session: &str, message_key: &str) -> Option<&str> {
        let message = self.sessions.get(session)?.messages.get(message_key)?;
        if message.find_stale {
            return None;
        }
        message.find_text.as_deref()
    }

    /// Whether the stage holds anything for a session.
    #[cfg(test)]
    pub fn has_session(&self, session: &str) -> bool {
        self.sessions.contains_key(session)
    }

    /// The text held for a message.
    #[cfg(test)]
    pub fn text(&self, session: &str, message_key: &str) -> Option<&str> {
        Some(
            self.sessions
                .get(session)?
                .messages
                .get(message_key)?
                .text
                .as_str(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn frame(
        kind: &str,
        session: &str,
        msg: &str,
        index: u64,
        partial: bool,
        text: &str,
    ) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": kind,
            "tug_session_id": session,
            "msg_id": msg,
            "block_index": index,
            "is_partial": partial,
            "text": text,
        }))
        .unwrap()
    }

    fn text(session: &str, msg: &str, partial: bool, text: &str) -> Vec<u8> {
        frame("assistant_text", session, msg, 1, partial, text)
    }

    fn bracket(kind: &str, session: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({ "type": kind, "tug_session_id": session })).unwrap()
    }

    fn render(stage: &mut RenderStage) -> Vec<RenderedSessionWire> {
        let job = stage.take_dirty();
        stage.settle(job.render())
    }

    /// The whole block list an emission describes, read against the one
    /// before it, as the deck reads it.
    fn whole(prev: &[RenderedBlockWire], wire: &RenderedMessageWire) -> Vec<RenderedBlockWire> {
        let mut out = prev[..wire.blocks_from as usize].to_vec();
        out.extend(wire.blocks.iter().cloned());
        out
    }

    #[test]
    fn the_key_is_the_reducers() {
        assert_eq!(wire_message_key("m1", Some(2)), "m1-b2");
        assert_eq!(wire_message_key("m1", None), "m1-bundefined");
    }

    #[test]
    fn partial_deltas_append_and_a_whole_frame_replaces() {
        let mut stage = RenderStage::new();
        assert!(stage.ingest(&text("s1", "m1", true, "Hello"), 0));
        assert!(stage.ingest(&text("s1", "m1", true, ", world"), 0));
        assert_eq!(stage.text("s1", "m1-b1"), Some("Hello, world"));
        assert!(stage.ingest(&text("s1", "m1", false, "Final."), 0));
        assert_eq!(stage.text("s1", "m1-b1"), Some("Final."));
    }

    #[test]
    fn a_fence_arrives_highlighted_and_stamped() {
        let mut stage = RenderStage::new();
        stage.ingest(
            &text("s1", "m1", false, "Run it:\n\n```rust\nfn main() {}\n```\n"),
            0,
        );
        let batch = render(&mut stage);
        let message = &batch[0].messages[0];
        let fence = &message.blocks[1];
        let html = &message.html[&fence.hash];
        assert!(html.contains("data-tug-highlighted=\"\""), "{html}");
        assert!(
            html.contains("<span class=\"tug-syn-keyword\">fn</span>"),
            "{html}"
        );
    }

    #[test]
    fn frames_the_stage_does_not_read_change_nothing() {
        let mut stage = RenderStage::new();
        assert!(!stage.ingest(br#"{"type":"tool_use","tug_session_id":"s1"}"#, 0));
        assert!(!stage.ingest(b"not json", 0));
        assert!(!stage.has_session("s1"));
        assert!(!stage.is_dirty());
    }

    #[test]
    fn a_delta_of_the_other_kind_is_dropped_as_the_reducer_drops_it() {
        let mut stage = RenderStage::new();
        stage.ingest(&frame("thinking_text", "s1", "m1", 0, true, "pondering"), 0);
        assert!(!stage.ingest(&frame("assistant_text", "s1", "m1", 0, true, " more"), 0));
        assert_eq!(stage.text("s1", "m1-b0"), Some("pondering"));
    }

    #[test]
    fn muted_replay_frames_emit_nothing_but_keep_the_text_for_find() {
        let mut stage = RenderStage::new();
        stage.ingest(&bracket("replay_started", "s1"), 0);
        assert!(!stage.ingest(&text("s1", "m1", false, "# Restored\n"), 0));
        assert!(!stage.is_dirty());
        assert!(render(&mut stage).is_empty());
        assert_eq!(stage.text("s1", "m1-b1"), Some("# Restored\n"));
        // Not rendered, so no find text is current yet: a find extracts it
        // from the text kept here, and the stage keeps what it extracted
        // while the source is unchanged.
        assert_eq!(stage.find_text("s1", "m1-b1"), None);
        let UnitText::Extract { source } = stage.find_unit("s1", "m1-b1") else {
            panic!("the replayed source, for extraction");
        };
        assert_eq!(source, "# Restored\n");
        stage.keep_find_texts(
            "s1",
            vec![Extracted {
                unit: "m1-b1".into(),
                source_hash: tugmark::text_hash("# Restored\n"),
                text: "Restored\n".into(),
            }],
        );
        assert_eq!(stage.find_text("s1", "m1-b1"), Some("Restored\n"));
        // An extraction from a source that has since moved is not kept.
        stage.keep_find_texts(
            "s1",
            vec![Extracted {
                unit: "m1-b1".into(),
                source_hash: tugmark::text_hash("something older"),
                text: "stale".into(),
            }],
        );
        assert_eq!(stage.find_text("s1", "m1-b1"), Some("Restored\n"));
        assert!(matches!(stage.find_unit("s1", "nope"), UnitText::Missing));
        // A resync never renders replayed history.
        stage.resync(None, None);
        assert!(!stage.is_dirty());

        stage.ingest(&bracket("replay_complete", "s1"), 0);
        assert!(stage.ingest(&text("s1", "m2", false, "Live."), 0));
        let batch = render(&mut stage);
        assert_eq!(batch[0].messages.len(), 1);
        assert_eq!(batch[0].messages[0].message_key, "m2-b1");
        assert_eq!(stage.find_text("s1", "m2-b1"), Some("Live.\n"));
    }

    #[test]
    fn a_growing_message_carries_html_only_for_new_hashes() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "m1", true, "# Title\n\nFirst para"), 0);
        let first = render(&mut stage);
        let message = &first[0].messages[0];
        assert_eq!(message.blocks.len(), 2);
        assert_eq!(message.html.len(), 2);

        stage.ingest(&text("s1", "m1", true, "graph.\n\nSecond"), 0);
        let second = render(&mut stage);
        let message = &second[0].messages[0];
        // The heading is unchanged, so the list starts after it; the
        // paragraph grew and the third is new.
        assert_eq!(
            (message.seq, message.base_seq, message.blocks_from),
            (2, 1, 1)
        );
        assert_eq!(message.blocks.len(), 2);
        let blocks = whole(&first[0].messages[0].blocks, message);
        assert_eq!(blocks.len(), 3);
        assert_eq!(message.html.len(), 2);
        assert!(!message.html.contains_key(&blocks[0].hash));
        assert!(message.html.contains_key(&blocks[1].hash));
        assert!(message.html.contains_key(&blocks[2].hash));

        let source = "# Title\n\nFirst paragraph.\n\nSecond";
        assert_eq!(message.text_length, source.encode_utf16().count() as u32);
        assert_eq!(message.text_hash, tugmark::text_hash(source).to_string());
    }

    #[test]
    fn the_block_list_is_a_diff_from_the_first_changed_block() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "m1", true, "One.\n\nTwo.\n\nThree"), 0);
        let first = render(&mut stage);
        let one = &first[0].messages[0];
        assert_eq!((one.seq, one.base_seq, one.blocks_from), (1, 0, 0));
        assert_eq!(one.blocks.len(), 3);

        // Only the last paragraph moves.
        stage.ingest(&text("s1", "m1", true, " more"), 0);
        let second = render(&mut stage);
        let two = &second[0].messages[0];
        assert_eq!((two.seq, two.base_seq, two.blocks_from), (2, 1, 2));
        assert_eq!(two.blocks.len(), 1);

        // A whole frame that rewrites the first block resends the list.
        stage.ingest(&text("s1", "m1", false, "Zero.\n\nTwo.\n\nThree more"), 0);
        let third = render(&mut stage);
        let three = &third[0].messages[0];
        assert_eq!((three.seq, three.base_seq, three.blocks_from), (3, 0, 0));
        let blocks: Vec<String> = three.blocks.iter().map(|b| b.hash.clone()).collect();
        let lone: Vec<String> =
            tugmark::render_blocks("Zero.\n\nTwo.\n\nThree more", tugmark::Highlight::On)
                .iter()
                .map(|b| b.hash.to_string())
                .collect();
        assert_eq!(blocks, lone);
    }

    #[test]
    fn thinking_and_text_both_render() {
        let mut stage = RenderStage::new();
        stage.ingest(&frame("thinking_text", "s1", "m1", 0, true, "*hmm*"), 0);
        stage.ingest(&frame("assistant_text", "s1", "m1", 1, true, "**yes**"), 0);
        let batch = render(&mut stage);
        let messages = &batch[0].messages;
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].channel, RenderChannel::Thinking);
        assert_eq!(messages[1].channel, RenderChannel::Text);
        let html: Vec<&String> = messages.iter().flat_map(|m| m.html.values()).collect();
        assert!(html[0].contains("<em>hmm</em>"), "{html:?}");
        assert!(html[1].contains("<strong>yes</strong>"), "{html:?}");
    }

    #[test]
    fn a_resync_re_sends_every_block_html() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "m1", false, "One.\n\nTwo."), 0);
        render(&mut stage);
        assert!(!stage.is_dirty());
        stage.resync(Some("s1"), Some("m1-b1"));
        assert!(stage.is_dirty());
        let batch = render(&mut stage);
        assert_eq!(batch[0].messages[0].html.len(), 2);
        // And the whole block list, as a new numbering's first.
        assert_eq!(batch[0].messages[0].blocks_from, 0);
        assert_eq!(batch[0].messages[0].base_seq, 0);
        assert_eq!(batch[0].messages[0].blocks.len(), 2);
        // Only the named message, and only once.
        stage.resync(Some("s2"), None);
        assert!(!stage.is_dirty());
        assert!(render(&mut stage).is_empty());
    }

    #[test]
    fn a_resync_during_a_render_survives_its_settle() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "m1", false, "One."), 0);
        render(&mut stage);
        stage.ingest(&text("s1", "m1", true, "\n\nTwo."), 0);
        let job = stage.take_dirty();
        stage.resync(None, None);
        assert!(stage.is_dirty());
        stage.settle(job.render());
        // The settle did not write back the set the resync cleared.
        let batch = render(&mut stage);
        assert_eq!(batch[0].messages[0].html.len(), 2);
    }

    #[test]
    fn a_closed_session_is_dropped_whole_and_its_render_in_flight_with_it() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "m1", false, "One."), 0);
        let job = stage.take_dirty();
        stage.drop_session("s1");
        assert!(stage.settle(job.render()).is_empty());
        assert!(!stage.has_session("s1"));
    }

    fn keys(batch: &[RenderedSessionWire]) -> Vec<String> {
        batch
            .iter()
            .flat_map(|s| s.messages.iter().map(|m| m.message_key.clone()))
            .collect()
    }

    fn tick(stage: &mut RenderStage, budget: usize) -> Vec<RenderedSessionWire> {
        let job = stage.take_dirty_within(budget);
        stage.settle(job.render())
    }

    #[test]
    fn a_multi_message_batch_renders_in_parallel_as_it_would_in_turn() {
        let mut stage = RenderStage::new();
        let mut expected = Vec::new();
        for i in 0..24 {
            let session = format!("s{}", i % 3);
            let body = format!("# Message {i}\n\n```rust\nfn f{i}() {{}}\n```\n\n- item {i}\n");
            stage.ingest(&text(&session, &format!("m{i}"), false, &body), 0);
            expected.push((session, format!("m{i}-b1"), body));
        }
        let batch = render(&mut stage);
        // Every message, in the order it turned dirty, grouped by session.
        let order: Vec<String> = expected.iter().map(|(_, k, _)| k.clone()).collect();
        let mut seen = keys(&batch);
        let mut want = order.clone();
        seen.sort();
        want.sort();
        assert_eq!(seen, want);
        for session in &batch {
            let in_session: Vec<&String> = order
                .iter()
                .zip(&expected)
                .filter(|(_, (s, _, _))| *s == session.tug_session_id)
                .map(|(k, _)| k)
                .collect();
            let got: Vec<&String> = session.messages.iter().map(|m| &m.message_key).collect();
            assert_eq!(got, in_session);
        }
        // Each one is what a lone render of its text makes.
        for (session, key, body) in &expected {
            let message = batch
                .iter()
                .find(|s| &s.tug_session_id == session)
                .and_then(|s| s.messages.iter().find(|m| &m.message_key == key))
                .unwrap();
            let lone = tugmark::render_blocks(body, tugmark::Highlight::On);
            let hashes: Vec<String> = lone.iter().map(|b| b.hash.to_string()).collect();
            let wire: Vec<String> = message.blocks.iter().map(|b| b.hash.clone()).collect();
            assert_eq!(wire, hashes, "{key}");
            for block in &lone {
                assert_eq!(message.html[&block.hash.to_string()], block.html, "{key}");
            }
            assert_eq!(
                stage.find_text(session, key),
                Some(tugmark::rendered_text(&lone).as_str())
            );
        }
        assert!(!stage.is_dirty());
    }

    #[test]
    fn a_tick_takes_its_budget_and_carries_the_rest_in_order() {
        let mut stage = RenderStage::new();
        let body = "x".repeat(100);
        for i in 0..5 {
            stage.ingest(&text("s1", &format!("m{i}"), false, &body), 0);
        }
        // 250 bytes holds two 100-byte messages; the third would pass it.
        let first = tick(&mut stage, 250);
        assert_eq!(keys(&first), ["m0-b1", "m1-b1"]);
        assert!(stage.is_dirty(), "the remainder waits for the next tick");
        // A message that turns dirty meanwhile queues behind the remainder.
        stage.ingest(&text("s1", "m0", true, "y"), 0);
        let second = tick(&mut stage, 250);
        assert_eq!(keys(&second), ["m2-b1", "m3-b1"]);
        let third = tick(&mut stage, 250);
        assert_eq!(keys(&third), ["m4-b1", "m0-b1"]);
        assert!(!stage.is_dirty());
    }

    #[test]
    fn a_message_larger_than_the_budget_renders_alone() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "big", false, &"z".repeat(500)), 0);
        stage.ingest(&text("s1", "small", false, "s"), 0);
        let first = tick(&mut stage, 100);
        assert_eq!(keys(&first), ["big-b1"]);
        let second = tick(&mut stage, 100);
        assert_eq!(keys(&second), ["small-b1"]);
    }

    #[test]
    fn the_idle_sweep_drops_render_state_and_keeps_find_text() {
        let mut stage = RenderStage::new();
        stage.ingest(&text("s1", "m1", false, "Old **news**."), 0);
        render(&mut stage);
        stage.ingest(&text("s2", "m2", false, "Fresh."), 50_000);
        render(&mut stage);
        assert_eq!(stage.sweep_idle(60_000, 30_000), vec!["s1".to_string()]);
        assert_eq!(stage.text("s1", "m1-b1"), Some(""));
        assert_eq!(stage.find_text("s1", "m1-b1"), Some("Old news.\n"));
        assert_eq!(stage.text("s2", "m2-b1"), Some("Fresh."));
        // A swept message is not resynced: there is nothing left to render.
        stage.resync(Some("s1"), None);
        assert!(!stage.is_dirty());
    }

    /// The catalog's longest streamed turn, filled with corpus text: the
    /// emission after the last delta describes exactly what `render_blocks`
    /// makes of the accumulated text.
    #[test]
    fn a_catalog_turn_ends_on_the_render_of_its_whole_text() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let catalog = manifest.join("tests/fixtures/stream-json-catalog");
        let mut versions: Vec<(Vec<u64>, std::path::PathBuf)> = std::fs::read_dir(&catalog)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                let name = path.file_name()?.to_str()?.strip_prefix('v')?.to_string();
                let parts: Option<Vec<u64>> = name.split('.').map(|p| p.parse().ok()).collect();
                Some((parts?, path))
            })
            .collect();
        versions.sort();
        let turn = versions
            .pop()
            .unwrap()
            .1
            .join("test-10-long-streaming-300-words.jsonl");
        let source = std::fs::read_to_string(
            manifest.join("../../../tugdeck/crates/tugmark/corpus/streams/source.md"),
        )
        .unwrap();

        let mut stage = RenderStage::new();
        let mut cursors: HashMap<String, usize> = HashMap::new();
        let mut lists: HashMap<String, Vec<RenderedBlockWire>> = HashMap::new();
        let mut take = |batch: Vec<RenderedSessionWire>| {
            for session in batch {
                for message in session.messages {
                    let prev = lists.remove(&message.message_key).unwrap_or_default();
                    lists.insert(message.message_key.clone(), whole(&prev, &message));
                }
            }
        };
        let mut frames = 0;
        for line in std::fs::read_to_string(&turn).unwrap().lines() {
            let mut value: Value = serde_json::from_str(line).unwrap();
            let kind = value["type"].as_str().unwrap_or_default().to_string();
            if kind != "assistant_text" && kind != "thinking_text" {
                continue;
            }
            // The catalog redacts prose to `{{text:len=N}}`; fill it with the
            // next N bytes of the corpus, snapped to a char boundary.
            let redacted = value["text"].as_str().unwrap();
            let len: usize = redacted
                .strip_prefix("{{text:len=")
                .and_then(|r| r.strip_suffix("}}"))
                .and_then(|n| n.parse().ok())
                .unwrap();
            let partial = value["is_partial"].as_bool().unwrap_or(false);
            let cursor = cursors.entry(kind.clone()).or_insert(0);
            let start = if partial { *cursor } else { 0 };
            let mut end = (start + len).min(source.len());
            while !source.is_char_boundary(end) {
                end += 1;
            }
            value["text"] = Value::String(source[start..end].to_string());
            *cursor = end;
            stage.ingest(&serde_json::to_vec(&value).unwrap(), 0);
            frames += 1;
            // A tick every few frames, as the bridge's period would.
            if frames % 7 == 0 {
                take(render(&mut stage));
            }
        }
        take(render(&mut stage));
        let hashes: HashMap<String, Vec<String>> = lists
            .into_iter()
            .map(|(key, list)| (key, list.into_iter().map(|b| b.hash).collect()))
            .collect();
        assert!(frames > 50, "the turn streams ({frames} frames)");
        assert_eq!(hashes.len(), 2, "thinking and text both rendered");
        // This capture's thinking is redacted to nothing; its text is not.
        assert!(!stage.text("{{uuid}}", "{{uuid}}-b1").unwrap().is_empty());
        for (key, emitted) in &hashes {
            let session = "{{uuid}}";
            let text = stage.text(session, key).unwrap();
            let expected: Vec<String> = tugmark::render_blocks(text, tugmark::Highlight::On)
                .iter()
                .map(|b| b.hash.to_string())
                .collect();
            assert_eq!(emitted, &expected, "{key}");
        }
    }

    /// [P08]'s measurement: one full render of 4, 32 and 128 KB documents.
    /// Run with `cargo nextest run -p tugcast --release --run-ignored only
    /// render_blocks_parse_time`.
    #[test]
    #[ignore]
    fn render_blocks_parse_time() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let corpus = manifest.join("../../../tugdeck/crates/tugmark/corpus");
        let mut seed = String::new();
        for dir in ["streams", "constructs"] {
            let mut paths: Vec<_> = std::fs::read_dir(corpus.join(dir))
                .unwrap()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "md"))
                .collect();
            paths.sort();
            for path in paths {
                seed.push_str(&std::fs::read_to_string(path).unwrap());
                seed.push_str("\n\n");
            }
        }
        for kb in [4usize, 32, 128] {
            let mut doc = String::new();
            while doc.len() < kb * 1024 {
                doc.push_str(&seed);
            }
            let mut cut = kb * 1024;
            while !doc.is_char_boundary(cut) {
                cut += 1;
            }
            doc.truncate(cut);
            let runs = 20;
            let mut times: Vec<f64> = (0..runs)
                .map(|_| {
                    let start = std::time::Instant::now();
                    let blocks = tugmark::render_blocks(&doc, tugmark::Highlight::On);
                    std::hint::black_box(blocks);
                    start.elapsed().as_secs_f64() * 1000.0
                })
                .collect();
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!(
                "render_blocks {kb:>3} KB: median {:.2} ms, max {:.2} ms",
                times[runs / 2],
                times[runs - 1]
            );
        }
    }
}
