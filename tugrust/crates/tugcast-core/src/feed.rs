//! Feed trait definitions for tugcast
//!
//! This module defines two types of feeds:
//! - StreamFeed: Continuous data streams (e.g., terminal output) using broadcast channels
//! - SnapshotFeed: Point-in-time snapshots (e.g., current state) using watch channels
//!
//! Feeds are **run-once owned tasks**: `run` consumes the boxed feed, so the
//! type system enforces single-run semantics (no runtime "already running"
//! guards, no `Mutex<Option<Receiver>>` take-patterns). A feed self-describes
//! its router registration — id, name, lag policy, channel capacity — so the
//! router can create the channel, record the policy, and spawn the task from
//! the boxed trait object alone.

use async_trait::async_trait;
use tokio::sync::broadcast;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::lag::LagPolicy;
use crate::protocol::{FeedId, Frame};

/// Default broadcast-channel capacity for stream feeds. Feeds with lighter
/// traffic (e.g. digest lines) override [`StreamFeed::channel_capacity`].
pub const DEFAULT_BROADCAST_CAPACITY: usize = 4096;

/// A feed that produces a continuous stream of frames
///
/// StreamFeeds use broadcast channels to send frames to multiple subscribers.
/// Each frame is delivered to all active subscribers. This is suitable for
/// high-throughput continuous data like terminal output.
///
/// The `#[async_trait]` macro is required because the feed router needs to store
/// feeds as `Box<dyn StreamFeed>`, which requires object safety. Native async fn
/// in traits is not object-safe in Rust.
#[async_trait]
pub trait StreamFeed: Send + Sync {
    /// Returns the feed ID this feed produces
    fn feed_id(&self) -> FeedId;

    /// Returns the human-readable name of this feed
    fn name(&self) -> &str;

    /// What the router should do when a client lags this feed's broadcast.
    fn lag_policy(&self) -> LagPolicy {
        LagPolicy::Warn
    }

    /// Capacity of the broadcast channel the router creates for this feed.
    fn channel_capacity(&self) -> usize {
        DEFAULT_BROADCAST_CAPACITY
    }

    /// Run the feed, sending frames on the broadcast channel until cancelled
    ///
    /// Consumes the feed (feeds run exactly once). This method should
    /// continuously produce frames and send them via the broadcast sender,
    /// respect the cancellation token, and return gracefully when
    /// cancellation is requested.
    ///
    /// # Arguments
    ///
    /// * `tx` - Broadcast sender for distributing frames to multiple subscribers
    /// * `cancel` - Cancellation token for graceful shutdown
    async fn run(self: Box<Self>, tx: broadcast::Sender<Frame>, cancel: CancellationToken);
}

/// A feed that produces point-in-time snapshots
///
/// SnapshotFeeds use watch channels to provide the latest snapshot to subscribers.
/// New subscribers immediately receive the current snapshot value. This is suitable
/// for state that changes infrequently or where clients need the current state on connect.
///
/// The `#[async_trait]` macro is required for the same object-safety reasons as StreamFeed.
#[async_trait]
pub trait SnapshotFeed: Send + Sync {
    /// Returns the feed ID this feed produces
    fn feed_id(&self) -> FeedId;

    /// Returns the human-readable name of this feed
    fn name(&self) -> &str;

    /// Run the feed, updating the watch channel with the latest snapshot until cancelled
    ///
    /// Consumes the feed (feeds run exactly once). This method should update
    /// the watch channel with new snapshots, respect the cancellation token,
    /// and return gracefully when cancellation is requested.
    ///
    /// # Arguments
    ///
    /// * `tx` - Watch sender for updating the current snapshot value
    /// * `cancel` - Cancellation token for graceful shutdown
    async fn run(self: Box<Self>, tx: watch::Sender<Frame>, cancel: CancellationToken);
}

/// Spawn a snapshot feed onto the runtime — the one way a `SnapshotFeed`
/// gets its task. Owners that manage multi-instance lifecycles (e.g. the
/// per-workspace registry) call this instead of invoking `run` concretely,
/// so every snapshot feed is produced through the trait.
pub fn spawn_snapshot_feed(
    feed: Box<dyn SnapshotFeed>,
    tx: watch::Sender<Frame>,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { feed.run(tx, cancel).await })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stream_feed_is_object_safe() {
        // This function exists to verify at compile time that StreamFeed is object-safe.
        // If this compiles, the trait can be used as Box<dyn StreamFeed>.
        fn _assert_object_safe(_: Box<dyn StreamFeed>) {}
    }

    #[test]
    fn test_snapshot_feed_is_object_safe() {
        // This function exists to verify at compile time that SnapshotFeed is object-safe.
        // If this compiles, the trait can be used as Box<dyn SnapshotFeed>.
        fn _assert_object_safe(_: Box<dyn SnapshotFeed>) {}
    }
}
