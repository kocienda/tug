//! `tugcast-core` — protocol types, frame encoding, and feed traits for tugcast
//!
//! This crate provides the binary frame protocol (FeedId + length + payload),
//! feed traits (StreamFeed for broadcast, SnapshotFeed for watch), and data
//! structures used by the tugcast WebSocket multiplexer.
//!
//! ## Modules
//!
//! - [`protocol`] - Binary frame protocol and FeedId definitions
//! - [`feed`] - Feed traits for stream and snapshot feeds
//! - [`lag`] - Lag-recovery policy and replay buffer for stream feeds
//! - [`types`] - Data structures for snapshot feeds (FsEvent, GitStatus)

pub mod feed;
pub mod lag;
pub mod protocol;
pub mod types;

pub use feed::{DEFAULT_BROADCAST_CAPACITY, SnapshotFeed, StreamFeed, spawn_snapshot_feed};
pub use lag::{LagPolicy, ReplayBuffer};
pub use protocol::{
    // Handshake constants
    CLOSE_BAD_HANDSHAKE,
    CLOSE_HANDSHAKE_TIMEOUT,
    CLOSE_VERSION_MISMATCH,
    FeedId,
    Frame,
    FrameFlags,
    HANDSHAKE_TIMEOUT,
    HEADER_SIZE,
    MAX_PAYLOAD_SIZE,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    ProtocolError,
    TugSessionId,
};
pub use types::{
    FileStatus, FileTreeSnapshot, FsEvent, GitStatus, OverviewAttachment, OverviewAuthor,
    OverviewPost, OverviewRef, OverviewRefKind, ScoredResult, SessionCurrentLine,
};

/// Default port for the Vite dev server.
///
/// This is the single source of truth for the Vite dev server port in Rust code.
/// Both `tugcast` and `tugtool` crates reference this constant. The actual port
/// is communicated at runtime via the `vite_port` field of the `DevMode` control
/// message; this constant serves as the fallback when that field is absent.
pub const DEFAULT_VITE_DEV_PORT: u16 = 55155;
