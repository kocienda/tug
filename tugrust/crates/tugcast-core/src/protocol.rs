//! Tugcast Binary Protocol v1
//!
//! Wire format per frame:
//! ```text
//! [1 byte FeedId][1 byte flags][4 bytes payload length (BE u32)][payload]
//! ```
//!
//! - **FeedId**: open `u8` namespace — known feeds have associated constants,
//!   unknown values pass through without error (opaque routing).
//! - **Flags**: bit 0 = frame kind (0 = data, 1 = control/meta).
//!   Bits 1–7 are reserved and must be 0; receivers ignore unknown flags.
//! - **Length**: big-endian `u32`, max [`MAX_PAYLOAD_SIZE`].

use std::fmt;

/// Maximum payload size in bytes (16 MB)
pub const MAX_PAYLOAD_SIZE: usize = 16 * 1024 * 1024;

/// Size of the frame header in bytes (1 FeedId + 1 flags + 4 length)
pub const HEADER_SIZE: usize = 6;

// ---------------------------------------------------------------------------
// FeedId — open u8 newtype
// ---------------------------------------------------------------------------

/// Identifies a data stream multiplexed over a single WebSocket connection.
///
/// `FeedId` is an open namespace: any `u8` value is valid on the wire.
/// Known feeds are exposed as associated constants; unknown values are
/// forwarded by the router without interpretation.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct FeedId(pub u8);

impl FeedId {
    // -- Terminal --
    /// Terminal output stream (tugcast → tugdeck)
    pub const TERMINAL_OUTPUT: Self = Self(0x00);
    /// Terminal input stream (tugdeck → tugcast)
    pub const TERMINAL_INPUT: Self = Self(0x01);
    /// Terminal resize events (tugdeck → tugcast)
    pub const TERMINAL_RESIZE: Self = Self(0x02);

    // -- Snapshot feeds --
    /// Filesystem events snapshot (tugcast → tugdeck)
    pub const FILESYSTEM: Self = Self(0x10);
    /// File tree scored results (tugcast → tugdeck)
    pub const FILETREE: Self = Self(0x11);
    /// File tree query (tugdeck → tugcast)
    pub const FILETREE_QUERY: Self = Self(0x12);
    /// Retired: the GIT status snapshot feed was replaced by CHANGESET
    /// (0x23) when the git card retired ([P16]). The constant stays
    /// reserved — never reuse 0x20 for another feed.
    pub const GIT: Self = Self(0x20);
    /// Git diff response — single-shot per `/diff` request (tugcast → tugdeck)
    pub const GIT_DIFF: Self = Self(0x21);
    /// Git diff request — `/diff` over the bound card's project dir (tugdeck → tugcast)
    pub const GIT_DIFF_QUERY: Self = Self(0x22);
    /// Retired: the per-workspace changeset snapshot feed was replaced by the
    /// account-global CHANGESET_ALL (0x24) aggregate. The constant stays
    /// reserved — never reuse 0x23 for another feed.
    pub const CHANGESET: Self = Self(0x23);
    /// Account-global aggregate changeset snapshot — every open project in
    /// one frame, delivered process-level like USAGE/PULSE (tugcast → tugdeck)
    pub const CHANGESET_ALL: Self = Self(0x24);
    /// Git log response — single-shot per request (tugcast → tugdeck)
    pub const GIT_LOG: Self = Self(0x25);
    /// Git log request — recent commits over the followed card's project dir (tugdeck → tugcast)
    pub const GIT_LOG_QUERY: Self = Self(0x26);
    /// Git HEAD-moved signal — a workspace's HEAD changed (commit/checkout/reset
    /// from any source), so a git-log consumer should re-request (tugcast → tugdeck)
    pub const GIT_HEAD: Self = Self(0x27);
    /// Commit-files response — single-shot per request (tugcast → tugdeck).
    /// The changed-file list (name-status + ± counts) for one commit sha, what
    /// a History row expands into ([P10]).
    pub const GIT_COMMIT_FILES: Self = Self(0x28);
    /// Commit-files request — the changed files of one commit sha over the
    /// followed card's project dir (tugdeck → tugcast)
    pub const GIT_COMMIT_FILES_QUERY: Self = Self(0x29);

    // -- Stats (retired) --
    /// Retired: the aggregate stats snapshot feed was removed along with the
    /// rest of the stats quartet when the 1 Hz unconditional push to every
    /// client was retired. The constant stays reserved — never reuse 0x30 for
    /// another feed.
    pub const STATS: Self = Self(0x30);
    /// Retired: the process-info stats feed was removed with the rest of the
    /// stats quartet. The constant stays reserved — never reuse 0x31 for
    /// another feed.
    pub const STATS_PROCESS_INFO: Self = Self(0x31);
    /// Retired: the token-usage stats feed was removed with the rest of the
    /// stats quartet. The constant stays reserved — never reuse 0x32 for
    /// another feed.
    pub const STATS_TOKEN_USAGE: Self = Self(0x32);
    /// Retired: the build-status stats feed was removed with the rest of the
    /// stats quartet. The constant stays reserved — never reuse 0x33 for
    /// another feed.
    pub const STATS_BUILD_STATUS: Self = Self(0x33);

    // -- Code (Claude Code bridge) --
    /// Code output stream (tugcast → tugdeck)
    pub const CODE_OUTPUT: Self = Self(0x40);
    /// Code input stream (tugdeck → tugcast)
    pub const CODE_INPUT: Self = Self(0x41);
    /// Per-session activity feed (tugcast → tugdeck). Carries binned
    /// per-channel work samples (text / tokens / tools / subagents rates
    /// and cpu / memory / disk gauges). tugcode is the single authoritative
    /// producer of the stream-derived channels: it emits `activity_delta`
    /// frames on CODE_OUTPUT, which the supervisor's merger diverts here.
    pub const ACTIVITY: Self = Self(0x42);

    // -- Defaults --
    /// Domain defaults snapshot (tugcast → tugdeck)
    pub const DEFAULTS: Self = Self(0x50);
    /// Per-session out-of-band metadata channel (tugcast → tugdeck).
    ///
    /// MULTIPLEXES three distinct payload kinds, each owning its own region
    /// of the client's session-metadata state — they must NOT clobber each
    /// other:
    /// - `system_metadata` — the active runtime snapshot (active model,
    ///   permissionMode, cwd, tools, version); arrives with init / post-turn.
    /// - `session_capabilities` — the turn-free `initialize` handshake (the
    ///   `/model` picker list, the command catalog, the current effort);
    ///   available from the drop, before any turn runs.
    /// - `rate_limit` — the per-turn quota broadcast (the Z4B rate chip).
    ///
    /// Named SIDEBAND (not METADATA) deliberately: the feed is the transport
    /// sideband, distinct from the `system_metadata` PAYLOAD it carries — the
    /// near-collision of those two names was a real source of confusion. The
    /// client retains the last frame PER KIND in its replay-on-subscribe
    /// cache so a late-binding card reconstructs all three independently.
    pub const SESSION_SIDEBAND: Self = Self(0x51);
    /// Session lifecycle state feed (tugcast → tugdeck)
    pub const SESSION_STATE: Self = Self(0x52);

    // -- Shell (reserved for Phase T2+) --
    /// Shell command output (tugcast → tugdeck)
    pub const SHELL_OUTPUT: Self = Self(0x60);
    /// Shell command input (tugdeck → tugcast)
    pub const SHELL_INPUT: Self = Self(0x61);

    // -- Refs (the match/search file-reference commands) --
    /// Streaming search results (tugcast → tugdeck): `refs_started`,
    /// `refs_rows` batches, `refs_complete`, one run at a time per session.
    pub const REFS_OUTPUT: Self = Self(0x62);
    /// Search requests (tugdeck → tugcast): `match`, `search`, `cancel`.
    pub const REFS_INPUT: Self = Self(0x63);

    // -- Overview (app-wide narration channel) --
    /// Overview posts (tugcast → tugdeck): one `OverviewPost` per frame, from
    /// any of the channel's three authors — the Observer's session digests,
    /// the Operator's answers, and the user's own questions echoed back
    /// after they are persisted.
    ///
    /// The byte was long reserved under the name `TUG_FEED` for a planned
    /// "tug surface feed" that was never built and whose needs were met
    /// elsewhere; the Overview is closer to that original meaning than the
    /// archived plan was, so it takes the id rather than opening a new one.
    pub const OVERVIEW: Self = Self(0x70);
    /// Overview questions (tugdeck → tugcast): the card's composer submitting
    /// `{body, request_id}` for the Operator. A sibling upstream id rather
    /// than bidirectional traffic on `OVERVIEW`, following the
    /// `SHELL_OUTPUT`/`SHELL_INPUT` and `USAGE`/`USAGE_QUERY` pairs.
    pub const OVERVIEW_INPUT: Self = Self(0x71);

    // -- Pulse (app-wide color commentary) --
    /// Commentator lines (tugcast → tugdeck)
    pub const PULSE: Self = Self(0x80);

    // -- Usage (subscription usage panel) --
    /// Usage panel response (tugcast → tugdeck), a single-shot `UsageSnapshot`
    /// carrying `claude -p "/usage"` output.
    pub const USAGE: Self = Self(0x90);
    /// Usage panel request (tugdeck → tugcast).
    pub const USAGE_QUERY: Self = Self(0x91);

    // -- Jots (reusable prompt fragments) --
    /// Jots document push (tugcast → tugdeck): the whole `jots.json`
    /// document plus its content hash, republished on every file change.
    pub const JOTS: Self = Self(0xA0);

    // -- Router-internal --
    /// Control commands (tugdeck → tugcast, tugcast → tugdeck)
    pub const CONTROL: Self = Self(0xC0);
    /// Heartbeat/keepalive frames (bidirectional)
    pub const HEARTBEAT: Self = Self(0xFF);

    /// Return the raw byte value.
    pub fn as_byte(self) -> u8 {
        self.0
    }

    /// Return the human-readable name for known feeds, or `None`.
    pub fn name(self) -> Option<&'static str> {
        match self {
            Self::TERMINAL_OUTPUT => Some("TerminalOutput"),
            Self::TERMINAL_INPUT => Some("TerminalInput"),
            Self::TERMINAL_RESIZE => Some("TerminalResize"),
            Self::FILESYSTEM => Some("Filesystem"),
            Self::FILETREE => Some("FileTree"),
            Self::FILETREE_QUERY => Some("FileTreeQuery"),
            Self::GIT => Some("Git"),
            Self::GIT_DIFF => Some("GitDiff"),
            Self::GIT_DIFF_QUERY => Some("GitDiffQuery"),
            Self::CHANGESET => Some("Changeset"),
            Self::CHANGESET_ALL => Some("ChangesetAll"),
            Self::GIT_LOG => Some("GitLog"),
            Self::GIT_LOG_QUERY => Some("GitLogQuery"),
            Self::GIT_HEAD => Some("GitHead"),
            Self::GIT_COMMIT_FILES => Some("GitCommitFiles"),
            Self::GIT_COMMIT_FILES_QUERY => Some("GitCommitFilesQuery"),
            Self::STATS => Some("Stats"),
            Self::STATS_PROCESS_INFO => Some("StatsProcessInfo"),
            Self::STATS_TOKEN_USAGE => Some("StatsTokenUsage"),
            Self::STATS_BUILD_STATUS => Some("StatsBuildStatus"),
            Self::CODE_OUTPUT => Some("CodeOutput"),
            Self::CODE_INPUT => Some("CodeInput"),
            Self::ACTIVITY => Some("Activity"),
            Self::DEFAULTS => Some("Defaults"),
            Self::SESSION_SIDEBAND => Some("SessionSideband"),
            Self::SESSION_STATE => Some("SessionState"),
            Self::PULSE => Some("Pulse"),
            Self::USAGE => Some("Usage"),
            Self::USAGE_QUERY => Some("UsageQuery"),
            Self::JOTS => Some("Jots"),
            Self::SHELL_OUTPUT => Some("ShellOutput"),
            Self::SHELL_INPUT => Some("ShellInput"),
            Self::REFS_OUTPUT => Some("RefsOutput"),
            Self::REFS_INPUT => Some("RefsInput"),
            Self::OVERVIEW => Some("Overview"),
            Self::OVERVIEW_INPUT => Some("OverviewInput"),
            Self::CONTROL => Some("Control"),
            Self::HEARTBEAT => Some("Heartbeat"),
            _ => None,
        }
    }
}

impl fmt::Debug for FeedId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name() {
            Some(name) => write!(f, "FeedId::{name}(0x{:02x})", self.0),
            None => write!(f, "FeedId(0x{:02x})", self.0),
        }
    }
}

impl fmt::Display for FeedId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name() {
            Some(name) => write!(f, "{name}(0x{:02x})", self.0),
            None => write!(f, "0x{:02x}", self.0),
        }
    }
}

// ---------------------------------------------------------------------------
// TugSessionId — wire-level session identifier
// ---------------------------------------------------------------------------

/// Opaque session identifier used by the session state feed and agent supervisor.
///
/// Defined here (rather than inside a feed module) because both the router and
/// `feeds::agent_supervisor` reference it; colocating it with the wire types
/// avoids a cyclic dependency between them.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct TugSessionId(pub String);

impl TugSessionId {
    /// Construct a `TugSessionId` from anything convertible into a `String`.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// Borrow the underlying string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TugSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// ---------------------------------------------------------------------------
// FrameFlags
// ---------------------------------------------------------------------------

/// Flags byte carried in every frame header.
///
/// Bit 0 (`KIND`): `0` = data frame, `1` = control/meta frame about this feed.
/// Bits 1–7: reserved, must be 0 on send, ignored on receive.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct FrameFlags(pub u8);

impl FrameFlags {
    /// Normal data frame (flags = 0x00).
    pub const DATA: Self = Self(0x00);
    /// Control/meta frame (flags = 0x01).
    pub const CONTROL: Self = Self(0x01);

    /// Bit mask for the kind bit.
    const KIND_BIT: u8 = 0x01;

    /// Returns `true` if this is a control/meta frame.
    pub fn is_control(self) -> bool {
        self.0 & Self::KIND_BIT != 0
    }

    /// Returns `true` if this is a data frame.
    pub fn is_data(self) -> bool {
        !self.is_control()
    }
}

impl Default for FrameFlags {
    fn default() -> Self {
        Self::DATA
    }
}

impl fmt::Debug for FrameFlags {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_control() {
            write!(f, "FrameFlags::CONTROL(0x{:02x})", self.0)
        } else {
            write!(f, "FrameFlags::DATA(0x{:02x})", self.0)
        }
    }
}

// ---------------------------------------------------------------------------
// Protocol handshake
// ---------------------------------------------------------------------------

/// Protocol identifier used in the WebSocket handshake.
pub const PROTOCOL_NAME: &str = "tugcast";

/// Current protocol version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Handshake timeout (how long the server waits for the client's hello).
pub const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// WebSocket close code for protocol version mismatch (4000-4999 = application-defined).
pub const CLOSE_VERSION_MISMATCH: u16 = 4001;

/// WebSocket close code for handshake timeout.
pub const CLOSE_HANDSHAKE_TIMEOUT: u16 = 4002;

/// WebSocket close code for malformed handshake.
pub const CLOSE_BAD_HANDSHAKE: u16 = 4003;

// ---------------------------------------------------------------------------
// ProtocolError
// ---------------------------------------------------------------------------

/// Errors that can occur during frame decoding
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// Not enough bytes available to decode a complete frame
    #[error("incomplete frame: need at least {needed} bytes, have {have}")]
    Incomplete { needed: usize, have: usize },

    /// The payload size exceeds the maximum allowed
    #[error("payload too large: {size} bytes exceeds maximum {max}")]
    PayloadTooLarge { size: usize, max: usize },
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/// A WebSocket frame containing a feed ID, flags, and payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// The feed this frame belongs to
    pub feed_id: FeedId,
    /// Header flags (data vs control, reserved bits)
    pub flags: FrameFlags,
    /// The frame payload data
    pub payload: Vec<u8>,
}

impl Frame {
    /// Create a new data frame with the given feed ID and payload.
    pub fn new(feed_id: FeedId, payload: Vec<u8>) -> Self {
        Frame {
            feed_id,
            flags: FrameFlags::DATA,
            payload,
        }
    }

    /// Create a new control/meta frame with the given feed ID and payload.
    pub fn control(feed_id: FeedId, payload: Vec<u8>) -> Self {
        Frame {
            feed_id,
            flags: FrameFlags::CONTROL,
            payload,
        }
    }

    /// Create a heartbeat frame (empty payload).
    pub fn heartbeat() -> Self {
        Frame {
            feed_id: FeedId::HEARTBEAT,
            flags: FrameFlags::DATA,
            payload: Vec::new(),
        }
    }

    /// Returns `true` if this is a control/meta frame.
    pub fn is_control(&self) -> bool {
        self.flags.is_control()
    }

    /// Encode this frame into wire format bytes.
    ///
    /// Wire format (v1):
    /// ```text
    /// [1 byte feed_id][1 byte flags][4 bytes payload length BE u32][payload]
    /// ```
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_SIZE + self.payload.len());
        bytes.push(self.feed_id.as_byte());
        bytes.push(self.flags.0);
        bytes.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        bytes
    }

    /// Decode a frame from wire format bytes.
    ///
    /// Returns `(Frame, bytes_consumed)` on success.
    ///
    /// # Errors
    ///
    /// - [`ProtocolError::Incomplete`] if the buffer is too small
    /// - [`ProtocolError::PayloadTooLarge`] if the payload exceeds [`MAX_PAYLOAD_SIZE`]
    pub fn decode(bytes: &[u8]) -> Result<(Frame, usize), ProtocolError> {
        if bytes.len() < HEADER_SIZE {
            return Err(ProtocolError::Incomplete {
                needed: HEADER_SIZE,
                have: bytes.len(),
            });
        }

        let feed_id = FeedId(bytes[0]);
        let flags = FrameFlags(bytes[1]);
        let length = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]) as usize;

        if length > MAX_PAYLOAD_SIZE {
            return Err(ProtocolError::PayloadTooLarge {
                size: length,
                max: MAX_PAYLOAD_SIZE,
            });
        }

        let total_size = HEADER_SIZE + length;
        if bytes.len() < total_size {
            return Err(ProtocolError::Incomplete {
                needed: total_size,
                have: bytes.len(),
            });
        }

        let payload = bytes[HEADER_SIZE..total_size].to_vec();

        Ok((
            Frame {
                feed_id,
                flags,
                payload,
            },
            total_size,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- FeedId constants ----

    #[test]
    fn test_known_feedid_byte_values() {
        assert_eq!(FeedId::TERMINAL_OUTPUT.as_byte(), 0x00);
        assert_eq!(FeedId::TERMINAL_INPUT.as_byte(), 0x01);
        assert_eq!(FeedId::TERMINAL_RESIZE.as_byte(), 0x02);
        assert_eq!(FeedId::FILESYSTEM.as_byte(), 0x10);
        assert_eq!(FeedId::FILETREE.as_byte(), 0x11);
        assert_eq!(FeedId::FILETREE_QUERY.as_byte(), 0x12);
        assert_eq!(FeedId::GIT.as_byte(), 0x20);
        assert_eq!(FeedId::GIT_DIFF.as_byte(), 0x21);
        assert_eq!(FeedId::GIT_DIFF_QUERY.as_byte(), 0x22);
        assert_eq!(FeedId::CHANGESET.as_byte(), 0x23);
        assert_eq!(FeedId::CHANGESET_ALL.as_byte(), 0x24);
        assert_eq!(FeedId::CHANGESET.name(), Some("Changeset"));
        assert_eq!(FeedId::GIT_LOG.as_byte(), 0x25);
        assert_eq!(FeedId::GIT_LOG_QUERY.as_byte(), 0x26);
        assert_eq!(FeedId::GIT_LOG.name(), Some("GitLog"));
        assert_eq!(FeedId::GIT_LOG_QUERY.name(), Some("GitLogQuery"));
        assert_eq!(FeedId::GIT_HEAD.as_byte(), 0x27);
        assert_eq!(FeedId::GIT_HEAD.name(), Some("GitHead"));
        assert_eq!(FeedId::GIT_COMMIT_FILES.as_byte(), 0x28);
        assert_eq!(FeedId::GIT_COMMIT_FILES.name(), Some("GitCommitFiles"));
        assert_eq!(FeedId::GIT_COMMIT_FILES_QUERY.as_byte(), 0x29);
        assert_eq!(
            FeedId::GIT_COMMIT_FILES_QUERY.name(),
            Some("GitCommitFilesQuery")
        );
        assert_eq!(FeedId::STATS.as_byte(), 0x30);
        assert_eq!(FeedId::STATS_PROCESS_INFO.as_byte(), 0x31);
        assert_eq!(FeedId::STATS_TOKEN_USAGE.as_byte(), 0x32);
        assert_eq!(FeedId::STATS_BUILD_STATUS.as_byte(), 0x33);
        assert_eq!(FeedId::CODE_OUTPUT.as_byte(), 0x40);
        assert_eq!(FeedId::CODE_INPUT.as_byte(), 0x41);
        assert_eq!(FeedId::ACTIVITY.as_byte(), 0x42);
        assert_eq!(FeedId::ACTIVITY.name(), Some("Activity"));
        assert_eq!(FeedId::DEFAULTS.as_byte(), 0x50);
        assert_eq!(FeedId::SESSION_SIDEBAND.as_byte(), 0x51);
        assert_eq!(FeedId::SESSION_STATE.as_byte(), 0x52);
        assert_eq!(FeedId::SESSION_SIDEBAND.name(), Some("SessionSideband"));
        assert_eq!(FeedId::SESSION_STATE.name(), Some("SessionState"));
        assert_eq!(FeedId::SHELL_OUTPUT.as_byte(), 0x60);
        assert_eq!(FeedId::SHELL_INPUT.as_byte(), 0x61);
        assert_eq!(FeedId::REFS_OUTPUT.as_byte(), 0x62);
        assert_eq!(FeedId::REFS_INPUT.as_byte(), 0x63);
        assert_eq!(FeedId::REFS_OUTPUT.name(), Some("RefsOutput"));
        assert_eq!(FeedId::REFS_INPUT.name(), Some("RefsInput"));
        assert_eq!(FeedId::USAGE.as_byte(), 0x90);
        assert_eq!(FeedId::USAGE_QUERY.as_byte(), 0x91);
        assert_eq!(FeedId::USAGE.name(), Some("Usage"));
        assert_eq!(FeedId::OVERVIEW.as_byte(), 0x70);
        assert_eq!(FeedId::OVERVIEW_INPUT.as_byte(), 0x71);
        assert_eq!(FeedId::OVERVIEW.name(), Some("Overview"));
        assert_eq!(FeedId::OVERVIEW_INPUT.name(), Some("OverviewInput"));
        assert_eq!(FeedId::CONTROL.as_byte(), 0xC0);
        assert_eq!(FeedId::HEARTBEAT.as_byte(), 0xFF);
    }

    // ---- The two feed tables ----

    /// This crate's own source, scanned for the `impl FeedId` table.
    const RUST_PROTOCOL_SRC: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/protocol.rs"));

    /// The deck's copy of the same table. The two files are one wire contract
    /// written twice, and nothing but the test below holds them together.
    const DECK_PROTOCOL_TS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tugdeck/src/protocol.ts"
    ));

    /// The size both tables must agree on, so a scanner that silently matches
    /// nothing cannot pass vacuously.
    const FEED_TABLE_LEN: usize = 38;

    /// A screaming-snake identifier, and nothing else.
    fn is_feed_constant_name(name: &str) -> bool {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    }

    /// Scans `pub const NAME: Self = Self(0xAB);` lines **inside the
    /// `impl FeedId` block only**. The bound is correctness rather than
    /// tidiness: `impl FrameFlags` declares its own `CONTROL` at `0x01` while
    /// `FeedId::CONTROL` is `0xC0`, so a block-unaware scan maps that name to
    /// the wrong byte and reports a divergence that is not there.
    fn scan_rust_feed_table(src: &str) -> std::collections::BTreeMap<String, u8> {
        let mut table = std::collections::BTreeMap::new();
        let mut in_block = false;
        for line in src.lines() {
            if !in_block {
                in_block = line.trim_end() == "impl FeedId {";
                continue;
            }
            if line == "}" {
                break;
            }
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("pub const ") else {
                continue;
            };
            let Some((name, rest)) = rest.split_once(": Self = Self(0x") else {
                continue;
            };
            let Some(hex) = rest.strip_suffix(");") else {
                continue;
            };
            let Ok(byte) = u8::from_str_radix(hex, 16) else {
                continue;
            };
            if !is_feed_constant_name(name) {
                continue;
            }
            assert!(
                table.insert(name.to_string(), byte).is_none(),
                "FeedId::{name} is declared twice in the Rust table"
            );
        }
        assert!(
            in_block,
            "the `impl FeedId` block was not found in tugcast-core/src/protocol.rs"
        );
        table
    }

    /// Scans `NAME: 0xAB,` lines inside `export const FeedId = { … } as const;`.
    fn scan_deck_feed_table(src: &str) -> std::collections::BTreeMap<String, u8> {
        let mut table = std::collections::BTreeMap::new();
        let mut in_block = false;
        for line in src.lines() {
            if !in_block {
                in_block = line.trim_end() == "export const FeedId = {";
                continue;
            }
            let trimmed = line.trim();
            if trimmed == "} as const;" {
                break;
            }
            let Some((name, rest)) = trimmed.split_once(": 0x") else {
                continue;
            };
            let Some(hex) = rest.strip_suffix(',') else {
                continue;
            };
            let Ok(byte) = u8::from_str_radix(hex, 16) else {
                continue;
            };
            if !is_feed_constant_name(name) {
                continue;
            }
            assert!(
                table.insert(name.to_string(), byte).is_none(),
                "{name} is declared twice in the deck table"
            );
        }
        assert!(
            in_block,
            "the `export const FeedId` block was not found in tugdeck/src/protocol.ts"
        );
        table
    }

    /// The Rust and TypeScript feed tables are one table written twice. A byte
    /// that agrees on only one side is a frame the deck decodes onto the wrong
    /// feed, or silently drops. Compare parsed bytes, never hex text: the two
    /// files disagree on hex case today.
    #[test]
    fn feed_id_tables_do_not_drift() {
        let rust = scan_rust_feed_table(RUST_PROTOCOL_SRC);
        let deck = scan_deck_feed_table(DECK_PROTOCOL_TS);

        assert_eq!(
            rust.len(),
            FEED_TABLE_LEN,
            "the Rust feed table holds {} constants, not {FEED_TABLE_LEN} — raise \
             FEED_TABLE_LEN if a feed was genuinely added",
            rust.len()
        );
        assert_eq!(
            deck.len(),
            FEED_TABLE_LEN,
            "the deck feed table holds {} constants, not {FEED_TABLE_LEN} — raise \
             FEED_TABLE_LEN if a feed was genuinely added",
            deck.len()
        );

        let rust_only: Vec<&str> = rust
            .keys()
            .filter(|name| !deck.contains_key(*name))
            .map(String::as_str)
            .collect();
        let deck_only: Vec<&str> = deck
            .keys()
            .filter(|name| !rust.contains_key(*name))
            .map(String::as_str)
            .collect();
        let mismatched: Vec<String> = rust
            .iter()
            .filter_map(|(name, byte)| {
                deck.get(name)
                    .filter(|deck_byte| *deck_byte != byte)
                    .map(|deck_byte| format!("{name} (Rust 0x{byte:02x}, deck 0x{deck_byte:02x})"))
            })
            .collect();

        assert!(
            rust_only.is_empty(),
            "declared in tugcast-core but missing from tugdeck/src/protocol.ts: {rust_only:?}"
        );
        assert!(
            deck_only.is_empty(),
            "declared in tugdeck/src/protocol.ts but missing from tugcast-core: {deck_only:?}"
        );
        assert!(
            mismatched.is_empty(),
            "the two feed tables disagree on these bytes: {mismatched:?}"
        );
    }

    #[test]
    fn test_tug_session_id_hashable_and_cloneable() {
        use std::collections::HashMap;
        let a = TugSessionId::new("sess-abc");
        let b = TugSessionId::new("sess-xyz");
        let a_clone = a.clone();

        let mut map: HashMap<TugSessionId, u32> = HashMap::new();
        map.insert(a.clone(), 1);
        map.insert(b.clone(), 2);

        assert_eq!(map.get(&a_clone), Some(&1));
        assert_eq!(map.get(&b), Some(&2));
        assert_eq!(a, a_clone);
        assert_ne!(a, b);
        assert_eq!(a.as_str(), "sess-abc");
        assert_eq!(format!("{a}"), "sess-abc");
    }

    #[test]
    fn test_feedid_is_open_any_byte_is_valid() {
        // Any u8 value can be a FeedId — no rejection
        for byte in 0..=255u8 {
            let id = FeedId(byte);
            assert_eq!(id.as_byte(), byte);
        }
    }

    #[test]
    fn test_feedid_equality_and_hash() {
        use std::collections::HashSet;
        let mut set = HashSet::new();
        set.insert(FeedId::TERMINAL_OUTPUT);
        set.insert(FeedId(0x00)); // Same value
        assert_eq!(set.len(), 1);
        set.insert(FeedId(0x99)); // Unknown feed
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn test_feedid_display_known() {
        assert_eq!(
            format!("{}", FeedId::TERMINAL_OUTPUT),
            "TerminalOutput(0x00)"
        );
        assert_eq!(format!("{}", FeedId::CODE_INPUT), "CodeInput(0x41)");
        assert_eq!(format!("{}", FeedId::HEARTBEAT), "Heartbeat(0xff)");
    }

    #[test]
    fn test_feedid_display_unknown() {
        assert_eq!(format!("{}", FeedId(0x99)), "0x99");
    }

    #[test]
    fn test_feedid_debug_known() {
        assert_eq!(format!("{:?}", FeedId::CONTROL), "FeedId::Control(0xc0)");
    }

    #[test]
    fn test_feedid_debug_unknown() {
        assert_eq!(format!("{:?}", FeedId(0xAB)), "FeedId(0xab)");
    }

    // ---- FrameFlags ----

    #[test]
    fn test_flags_data() {
        assert!(FrameFlags::DATA.is_data());
        assert!(!FrameFlags::DATA.is_control());
    }

    #[test]
    fn test_flags_control() {
        assert!(FrameFlags::CONTROL.is_control());
        assert!(!FrameFlags::CONTROL.is_data());
    }

    #[test]
    fn test_flags_default_is_data() {
        assert_eq!(FrameFlags::default(), FrameFlags::DATA);
    }

    #[test]
    fn test_flags_unknown_bits_ignored_for_kind() {
        // Bits 1-7 set, but bit 0 is 0 → still data
        let flags = FrameFlags(0xFE);
        assert!(flags.is_data());
        // Bits 1-7 set, bit 0 is 1 → control
        let flags = FrameFlags(0xFF);
        assert!(flags.is_control());
    }

    // ---- Frame construction ----

    #[test]
    fn test_frame_new_is_data() {
        let frame = Frame::new(FeedId::TERMINAL_OUTPUT, vec![1, 2, 3]);
        assert!(frame.flags.is_data());
        assert!(!frame.is_control());
    }

    #[test]
    fn test_frame_control_is_control() {
        let frame = Frame::control(FeedId::CODE_OUTPUT, b"lag_recovery".to_vec());
        assert!(frame.is_control());
        assert!(frame.flags.is_control());
    }

    #[test]
    fn test_heartbeat_convenience() {
        let frame = Frame::heartbeat();
        assert_eq!(frame.feed_id, FeedId::HEARTBEAT);
        assert!(frame.flags.is_data());
        assert!(frame.payload.is_empty());
    }

    // ---- Encode/decode round trips ----

    #[test]
    fn test_round_trip_terminal_output() {
        let original = Frame::new(FeedId::TERMINAL_OUTPUT, b"hello world".to_vec());
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_terminal_input() {
        let original = Frame::new(FeedId::TERMINAL_INPUT, b"test input".to_vec());
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_terminal_resize() {
        let original = Frame::new(
            FeedId::TERMINAL_RESIZE,
            b"{\"cols\": 80, \"rows\": 24}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_heartbeat() {
        let original = Frame::heartbeat();
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_filesystem() {
        let original = Frame::new(
            FeedId::FILESYSTEM,
            b"{\"kind\":\"Created\",\"path\":\"src/main.rs\"}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_git() {
        let original = Frame::new(
            FeedId::GIT,
            b"{\"branch\":\"main\",\"ahead\":0,\"behind\":0}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_code_output() {
        let original = Frame::new(
            FeedId::CODE_OUTPUT,
            b"{\"type\":\"assistant_text\",\"msg_id\":\"123\"}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_code_input() {
        let original = Frame::new(
            FeedId::CODE_INPUT,
            b"{\"type\":\"user_message\",\"text\":\"hello\"}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_control() {
        let original = Frame::new(FeedId::CONTROL, br#"{"action":"restart"}"#.to_vec());
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_stats() {
        let original = Frame::new(
            FeedId::STATS,
            b"{\"collectors\":{},\"timestamp\":\"2026-02-15T10:30:05Z\"}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_stats_process_info() {
        let original = Frame::new(
            FeedId::STATS_PROCESS_INFO,
            b"{\"name\":\"process_info\",\"pid\":12345}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_stats_token_usage() {
        let original = Frame::new(
            FeedId::STATS_TOKEN_USAGE,
            b"{\"name\":\"token_usage\",\"total_tokens\":23000}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_stats_build_status() {
        let original = Frame::new(
            FeedId::STATS_BUILD_STATUS,
            b"{\"name\":\"build_status\",\"status\":\"idle\"}".to_vec(),
        );
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_defaults() {
        let payload =
            br#"{"domains":{"dev.tugapp.deck.theme":{"generation":7,"entries":{"active-theme":{"kind":"string","value":"brio"}}}}}"#
                .to_vec();
        let original = Frame::new(FeedId::DEFAULTS, payload);
        let encoded = original.encode();
        assert_eq!(encoded[0], 0x50);
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_control_frame_flag() {
        // A control/meta frame round-trips with the flag preserved
        let original = Frame::control(FeedId::CODE_OUTPUT, b"{\"type\":\"lag_recovery\"}".to_vec());
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert!(decoded.is_control());
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn test_round_trip_unknown_feed_id() {
        // Unknown FeedId 0x99 round-trips without error
        let original = Frame::new(FeedId(0x99), b"opaque payload".to_vec());
        let encoded = original.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }

    // ---- Golden byte tests (wire format verification) ----

    #[test]
    fn test_golden_terminal_output_hello() {
        let frame = Frame::new(FeedId::TERMINAL_OUTPUT, b"hello".to_vec());
        let encoded = frame.encode();
        // Wire format v1:
        // [0x00] - TerminalOutput
        // [0x00] - flags (data)
        // [0x00, 0x00, 0x00, 0x05] - length 5 (big-endian)
        // [0x68, 0x65, 0x6c, 0x6c, 0x6f] - "hello"
        assert_eq!(
            encoded,
            vec![
                0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f
            ]
        );
    }

    #[test]
    fn test_golden_heartbeat_empty() {
        let frame = Frame::heartbeat();
        let encoded = frame.encode();
        // [0xFF] - Heartbeat
        // [0x00] - flags (data)
        // [0x00, 0x00, 0x00, 0x00] - length 0
        assert_eq!(encoded, vec![0xFF, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn test_golden_stats_frame() {
        let frame = Frame::new(FeedId::STATS, b"{}".to_vec());
        let encoded = frame.encode();
        // [0x30] - Stats
        // [0x00] - flags (data)
        // [0x00, 0x00, 0x00, 0x02] - length 2
        // [0x7b, 0x7d] - "{}"
        assert_eq!(
            encoded,
            vec![0x30, 0x00, 0x00, 0x00, 0x00, 0x02, 0x7b, 0x7d]
        );
    }

    #[test]
    fn test_golden_defaults_frame() {
        let frame = Frame::new(FeedId::DEFAULTS, b"{}".to_vec());
        let encoded = frame.encode();
        // [0x50] - Defaults
        // [0x00] - flags (data)
        // [0x00, 0x00, 0x00, 0x02] - length 2
        // [0x7b, 0x7d] - "{}"
        assert_eq!(
            encoded,
            vec![0x50, 0x00, 0x00, 0x00, 0x00, 0x02, 0x7b, 0x7d]
        );
    }

    #[test]
    fn test_golden_control_restart() {
        let payload = br#"{"action":"restart"}"#;
        let frame = Frame::new(FeedId::CONTROL, payload.to_vec());
        let encoded = frame.encode();
        assert_eq!(encoded[0], 0xC0); // Control
        assert_eq!(encoded[1], 0x00); // flags (data)
        assert_eq!(&encoded[2..6], &[0x00, 0x00, 0x00, 0x14]); // length 20
        assert_eq!(&encoded[6..], payload);
    }

    #[test]
    fn test_golden_control_meta_frame() {
        let payload = br#"{"type":"lag_recovery"}"#;
        let frame = Frame::control(FeedId::CODE_OUTPUT, payload.to_vec());
        let encoded = frame.encode();
        assert_eq!(encoded[0], 0x40); // CodeOutput
        assert_eq!(encoded[1], 0x01); // flags (control)
        let length = u32::from_be_bytes([encoded[2], encoded[3], encoded[4], encoded[5]]);
        assert_eq!(length as usize, payload.len());
        assert_eq!(&encoded[6..], payload);
    }

    // ---- Edge cases ----

    #[test]
    fn test_decode_empty_payload() {
        let frame = Frame::new(FeedId::TERMINAL_OUTPUT, vec![]);
        let encoded = frame.encode();
        let (decoded, _) = Frame::decode(&encoded).unwrap();
        assert!(decoded.payload.is_empty());
        assert_eq!(decoded.feed_id, FeedId::TERMINAL_OUTPUT);
    }

    #[test]
    fn test_decode_truncated_header() {
        let bytes = vec![0x00, 0x00, 0x00];
        let result = Frame::decode(&bytes);
        assert_eq!(
            result,
            Err(ProtocolError::Incomplete {
                needed: HEADER_SIZE,
                have: 3
            })
        );
    }

    #[test]
    fn test_decode_truncated_payload() {
        // Header says 10 bytes payload, but only 5 provided
        let mut bytes = vec![0x00, 0x00, 0x00, 0x00, 0x00, 10];
        bytes.extend_from_slice(b"hello");
        let result = Frame::decode(&bytes);
        assert_eq!(
            result,
            Err(ProtocolError::Incomplete {
                needed: HEADER_SIZE + 10,
                have: 11
            })
        );
    }

    #[test]
    fn test_decode_oversized_payload() {
        let oversized = (MAX_PAYLOAD_SIZE + 1) as u32;
        let bytes = vec![
            0x00, // feed_id
            0x00, // flags
            (oversized >> 24) as u8,
            (oversized >> 16) as u8,
            (oversized >> 8) as u8,
            oversized as u8,
        ];
        let result = Frame::decode(&bytes);
        assert_eq!(
            result,
            Err(ProtocolError::PayloadTooLarge {
                size: MAX_PAYLOAD_SIZE + 1,
                max: MAX_PAYLOAD_SIZE
            })
        );
    }

    #[test]
    fn test_decode_with_extra_bytes() {
        let frame = Frame::new(FeedId::TERMINAL_OUTPUT, b"test".to_vec());
        let mut encoded = frame.encode();
        encoded.extend_from_slice(b"extra data");
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded.payload, b"test");
        assert_eq!(consumed, HEADER_SIZE + 4);
    }

    #[test]
    fn test_bytes_consumed_matches_encoded_length() {
        let frame = Frame::new(FeedId::TERMINAL_INPUT, b"test data".to_vec());
        let encoded = frame.encode();
        let (_, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(consumed, HEADER_SIZE + 9);
    }

    #[test]
    fn test_header_size_is_six() {
        assert_eq!(HEADER_SIZE, 6);
    }

    #[test]
    fn test_max_payload_size_is_16mb() {
        assert_eq!(MAX_PAYLOAD_SIZE, 16 * 1024 * 1024);
    }

    // ---- Handshake constants ----

    #[test]
    fn test_protocol_name() {
        assert_eq!(PROTOCOL_NAME, "tugcast");
    }

    #[test]
    fn test_protocol_version() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    #[test]
    fn test_close_codes_in_application_range() {
        // WebSocket application-defined close codes must be 4000-4999
        assert!((4000..=4999).contains(&CLOSE_VERSION_MISMATCH));
        assert!((4000..=4999).contains(&CLOSE_HANDSHAKE_TIMEOUT));
        assert!((4000..=4999).contains(&CLOSE_BAD_HANDSHAKE));
    }

    #[test]
    fn test_handshake_hello_json() {
        // Verify the client hello message format
        let hello = serde_json::json!({
            "protocol": PROTOCOL_NAME,
            "version": PROTOCOL_VERSION,
        });
        assert_eq!(hello["protocol"], "tugcast");
        assert_eq!(hello["version"], 1);
    }

    #[test]
    fn test_handshake_response_json() {
        // Verify the server response format
        let response = serde_json::json!({
            "protocol": PROTOCOL_NAME,
            "version": PROTOCOL_VERSION,
            "capabilities": [],
        });
        assert_eq!(response["protocol"], "tugcast");
        assert_eq!(response["version"], 1);
        assert!(response["capabilities"].as_array().unwrap().is_empty());
    }
}
