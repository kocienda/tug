//! ACTIVITY feed OS instrument.
//!
//! The stream-derived activity channels (text / tokens / tools / subagents)
//! are produced by tugcode and diverted by the supervisor's merger ([P13])
//! into the session's activity [`tape`], which publishes them onto
//! `FeedId::ACTIVITY` a bin at a time. This module adds the *cast-side* half: the OS
//! signals (CPU / memory / disk) sampled over each session's tugcode process
//! **subtree**, published onto the same feed as gauge channels ([P09]).
//!
//! - [`resource`] owns the subtree sampler: one shared `System`, a
//!   `parent()`-link walk from each session's tugcode child pid, and the
//!   `(pid, start_time)` reuse-guard that keeps a recycled pid from being
//!   misattributed ([P08], [P10], [P20]).

//! - [`tape`] holds each session's recent activity: the last window of rate
//!   bins, stamped by index, and the gauges' current levels.

pub mod resource;
pub mod tape;
