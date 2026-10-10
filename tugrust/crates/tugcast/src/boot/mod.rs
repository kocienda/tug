//! tugcast's startup, one function per stage.
//!
//! `main` is the sequence of these calls, in this order, and the order is the
//! server's: each stage takes what the stages before it produced and returns
//! what the stages after it read. A stage that needs a value computed earlier
//! receives it as a parameter rather than reaching for it, so what a stage
//! depends on is written on its signature.
//!
//! The order: [`early`], [`bind`], [`streams`], [`ledgers`], [`feeds`],
//! [`ink_ledgers`], [`supervisor`], [`serve`], [`shutdown`]. `streams` and
//! `ink_ledgers` are second entry points of the feeds and ledgers stages,
//! where that work sits in startup today apart from the rest of its stage.

mod bind;
mod early;
mod feeds;
mod ledgers;
mod serve;
mod shutdown;
mod supervisor;

pub(crate) use bind::{Bound, bind};
pub(crate) use early::{Early, early};
pub(crate) use feeds::{Feeds, Streams, feeds, streams};
pub(crate) use ledgers::{InkLedgers, Ledgers, ink_ledgers, ledgers};
pub(crate) use serve::{Runtime, serve};
pub(crate) use shutdown::{Shutdown, shutdown};
pub(crate) use supervisor::supervisor;
