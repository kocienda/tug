//! Lag-recovery policy for stream feeds.
//!
//! Every stream feed declares what the router should do when a client falls
//! behind its broadcast channel ([`crate::feed::StreamFeed::lag_policy`]).
//! The policy — and the [`ReplayBuffer`] the `Replay` variant carries — lives
//! here in tugcast-core so the feed traits can be self-describing; the router
//! consumes it on `BroadcastStreamRecvError::Lagged`.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;

use crate::protocol::Frame;

/// Shared replay buffer for lag recovery on stream feeds.
///
/// The producer pushes frames; on lag the router replays the buffer contents
/// to the client. Thread-safe via `Arc<Mutex<_>>`.
#[derive(Clone)]
pub struct ReplayBuffer {
    frames: Arc<Mutex<VecDeque<Frame>>>,
    capacity: usize,
}

impl ReplayBuffer {
    /// Create a new replay buffer with the given maximum capacity.
    pub fn new(capacity: usize) -> Self {
        Self {
            frames: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity,
        }
    }

    /// Push a frame into the buffer, evicting the oldest if at capacity.
    pub fn push(&self, frame: Frame) {
        let mut buf = self.frames.lock();
        if buf.len() >= self.capacity {
            buf.pop_front();
        }
        buf.push_back(frame);
    }

    /// Return a snapshot (clone) of all buffered frames.
    pub fn snapshot(&self) -> Vec<Frame> {
        self.frames.lock().iter().cloned().collect()
    }

    /// Number of frames currently in the buffer.
    pub fn len(&self) -> usize {
        self.frames.lock().len()
    }

    /// Whether the buffer holds no frames.
    pub fn is_empty(&self) -> bool {
        self.frames.lock().is_empty()
    }
}

// Manual Debug (doesn't derive because of the Mutex).
impl std::fmt::Debug for ReplayBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let len = self.frames.lock().len();
        write!(f, "ReplayBuffer({}/{})", len, self.capacity)
    }
}

/// What the router should do when a client falls behind on a stream feed.
#[derive(Debug, Clone)]
pub enum LagPolicy {
    /// Re-enter BOOTSTRAP state to recover (e.g. terminal output).
    Bootstrap,
    /// Replay from a shared ring buffer, then resume live streaming.
    Replay(ReplayBuffer),
    /// Log a warning and continue — the client may miss frames.
    Warn,
}

// Manual PartialEq: compare variant tags only (ReplayBuffer is not meaningfully comparable).
impl PartialEq for LagPolicy {
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (LagPolicy::Bootstrap, LagPolicy::Bootstrap)
                | (LagPolicy::Replay(_), LagPolicy::Replay(_))
                | (LagPolicy::Warn, LagPolicy::Warn)
        )
    }
}
impl Eq for LagPolicy {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::FeedId;

    #[test]
    fn replay_buffer_evicts_oldest_at_capacity() {
        let buf = ReplayBuffer::new(2);
        buf.push(Frame::new(FeedId::CODE_OUTPUT, vec![1]));
        buf.push(Frame::new(FeedId::CODE_OUTPUT, vec![2]));
        buf.push(Frame::new(FeedId::CODE_OUTPUT, vec![3]));
        let frames = buf.snapshot();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].payload, vec![2]);
        assert_eq!(frames[1].payload, vec![3]);
    }

    #[test]
    fn lag_policy_eq_compares_variant_tags() {
        assert_eq!(LagPolicy::Warn, LagPolicy::Warn);
        assert_eq!(
            LagPolicy::Replay(ReplayBuffer::new(1)),
            LagPolicy::Replay(ReplayBuffer::new(99))
        );
        assert_ne!(LagPolicy::Bootstrap, LagPolicy::Warn);
    }
}
