//! tugcore — shared low-level primitives for Tug binaries.
//!
//! This crate is the foundation other Tug crates build on. It holds
//! identity, path, port-allocation, and registry helpers — code that
//! the tugcast, tugbank, tuglog, tug, and Swift-bridged binaries
//! all need to agree on but that does not belong inside any single
//! binary.
//!
//! Nothing in this crate may depend on any other Tug crate.

pub mod instance;
pub mod janitor;
pub mod ledger_db;
pub mod pathform;
pub mod ports;
pub mod quiesce;
pub mod registry;
#[cfg(test)]
mod source_scan;

/// Resolve the per-instance data directory for `instance_id` without
/// consulting the environment. Mirrors `instance::data_dir` but with
/// an explicit ID — used by external CLIs (e.g. `tugtool host instance
/// remove`) operating on instances that are not the caller.
pub fn instance_data_dir_for(instance_id: &str) -> std::path::PathBuf {
    instances_root().join(instance_id)
}

/// Resolve the `instances/` root directory, the parent of every
/// per-instance data dir.
pub fn instances_root() -> std::path::PathBuf {
    instance::base_data_dir().join("instances")
}
